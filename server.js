const express = require('express');
const cors = require('cors');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// CORS configuration (unchanged)
app.use(cors({
  origin: [
    'https://paycryptv1.vercel.app',
    'https://admin.paycrypt.org',
    'https://www.paycrypt.org',
    'https://paycrypt.org',
    'http://localhost:5173',
    'https://miniapp.paycrypt.org',
    'http://localhost:3000'
  ]
}));

// Your margin in Naira
const MARGIN_NGN = 20;

// Database setup
const dbPath = path.join(__dirname, 'price_cache.db');
const db = new sqlite3.Database(dbPath);

// Initialize database
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS price_cache (
    token_id TEXT PRIMARY KEY,
    usd_price REAL,
    ngn_price REAL,
    original_ngn REAL,
    last_updated INTEGER,
    source TEXT DEFAULT 'coingecko'
  )`);
  
  db.run(`CREATE TABLE IF NOT EXISTS api_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint TEXT,
    status TEXT,
    timestamp INTEGER,
    response_time INTEGER,
    tokens_requested TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS fetch_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER,
    status TEXT,
    tokens_count INTEGER,
    error_message TEXT,
    response_time INTEGER
  )`);
});

// In-memory cache for speed
let memoryCache = {};
let lastSuccessfulFetch = 0;
let isFetching = false;
let fetchAttempts = 0;
let serverStartTime = Date.now();

// Configuration
const BACKGROUND_FETCH_INTERVAL = 5 * 60 * 1000; // 5 minutes
const CACHE_FRESH_DURATION = 10 * 60 * 1000; // 10 minutes (consider fresh)
const CACHE_STALE_DURATION = 2 * 60 * 60 * 1000; // 2 hours (still usable)

// Default tokens to always fetch
const DEFAULT_TOKENS = [
  'bitcoin', 'ethereum', 'tether', 'usd-coin', 'binancecoin', 
  'cardano', 'solana', 'polygon', 'chainlink', 'send-token-2'
];

// Database helper functions
function saveToDatabase(tokenData) {
  return new Promise((resolve, reject) => {
    const stmt = db.prepare(`INSERT OR REPLACE INTO price_cache 
      (token_id, usd_price, ngn_price, original_ngn, last_updated, source) 
      VALUES (?, ?, ?, ?, ?, ?)`);
    
    const timestamp = Date.now();
    
    Object.entries(tokenData).forEach(([tokenId, prices]) => {
      stmt.run([
        tokenId,
        prices.usd || null,
        prices.ngn || null,
        prices.ngn ? prices.ngn - MARGIN_NGN : null,
        timestamp,
        'coingecko'
      ]);
    });
    
    stmt.finalize((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function loadFromDatabase(tokenIds = null) {
  return new Promise((resolve, reject) => {
    let query = 'SELECT * FROM price_cache';
    let params = [];
    
    if (tokenIds && tokenIds.length > 0) {
      const placeholders = tokenIds.map(() => '?').join(',');
      query += ` WHERE token_id IN (${placeholders})`;
      params = tokenIds;
    }
    
    db.all(query, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      
      const data = {};
      rows.forEach(row => {
        data[row.token_id] = {
          usd: row.usd_price,
          ngn: row.ngn_price
        };
      });
      
      resolve(data);
    });
  });
}

function logFetchAttempt(status, tokensCount = 0, errorMessage = null, responseTime = 0) {
  const stmt = db.prepare(`INSERT INTO fetch_logs 
    (timestamp, status, tokens_count, error_message, response_time) 
    VALUES (?, ?, ?, ?, ?)`);
  
  stmt.run([
    Date.now(),
    status,
    tokensCount,
    errorMessage,
    responseTime
  ]);
  
  stmt.finalize();
}

function logApiCall(endpoint, status, responseTime, tokensRequested) {
  const stmt = db.prepare(`INSERT INTO api_metrics 
    (endpoint, status, timestamp, response_time, tokens_requested) 
    VALUES (?, ?, ?, ?, ?)`);
  
  stmt.run([
    endpoint,
    status,
    Date.now(),
    responseTime,
    tokensRequested
  ]);
  
  stmt.finalize();
}

// Background fetch function
async function backgroundFetchPrices() {
  if (isFetching) {
    console.log('⏳ Background fetch already in progress, skipping...');
    return;
  }

  isFetching = true;
  fetchAttempts++;
  const startTime = Date.now();
  
  try {
    console.log(`🔄 Background fetch #${fetchAttempts} starting...`);
    
    const tokenList = DEFAULT_TOKENS.join(',');
    const coinGeckoUrl = `https://api.coingecko.com/api/v3/simple/price?ids=${tokenList}&vs_currencies=usd,ngn`;
    
    const response = await axios.get(coinGeckoUrl, {
      timeout: 30000,
      headers: {
        'User-Agent': 'PayCrypt-API/1.0',
        'Accept': 'application/json'
      }
    });
    
    const originalData = response.data;
    
    if (originalData && Object.keys(originalData).length > 0) {
      // Apply margin to NGN prices
      const modifiedData = {};
      
      Object.entries(originalData).forEach(([tokenId, prices]) => {
        modifiedData[tokenId] = {
          ...prices,
          ngn: prices.ngn ? prices.ngn + MARGIN_NGN : prices.ngn
        };
      });
      
      // Update both memory cache and database
      memoryCache = { ...memoryCache, ...modifiedData };
      lastSuccessfulFetch = Date.now();
      
      // Save to database
      await saveToDatabase(modifiedData);
      
      const responseTime = Date.now() - startTime;
      console.log(`✅ Background fetch SUCCESS! Updated ${Object.keys(modifiedData).length} tokens (${responseTime}ms)`);
      
      logFetchAttempt('success', Object.keys(modifiedData).length, null, responseTime);
      
    } else {
      throw new Error('Empty response from CoinGecko');
    }
    
  } catch (error) {
    const responseTime = Date.now() - startTime;
    console.error(`❌ Background fetch FAILED (attempt #${fetchAttempts}):`, error.message);
    logFetchAttempt('error', 0, error.message, responseTime);
    
    // Don't reset lastSuccessfulFetch - keep serving cached data
  } finally {
    isFetching = false;
  }
}

// Load cache from database on startup
async function initializeCache() {
  console.log('🚀 SERVER STARTING (Cold Start Detection)');
  console.log(`📅 Server start time: ${new Date().toISOString()}`);
  
  try {
    console.log('📚 Loading cache from database...');
    const dbData = await loadFromDatabase();
    
    if (Object.keys(dbData).length > 0) {
      memoryCache = dbData;
      
      // Find the most recent update time
      const result = await new Promise((resolve, reject) => {
        db.get('SELECT MAX(last_updated) as latest FROM price_cache', (err, row) => {
          if (err) reject(err);
          else resolve(row);
        });
      });
      
      if (result && result.latest) {
        lastSuccessfulFetch = result.latest;
        const ageMinutes = Math.floor((Date.now() - result.latest) / 60000);
        console.log(`✅ Loaded ${Object.keys(dbData).length} tokens from database (${ageMinutes} min old)`);
      }
    } else {
      console.log('📭 Database is empty - will fetch fresh data');
    }
    
    // Immediate background fetch if data is stale or missing
    if (Object.keys(memoryCache).length === 0 || (Date.now() - lastSuccessfulFetch) > CACHE_FRESH_DURATION) {
      console.log('🔄 Triggering immediate background fetch...');
      setTimeout(() => backgroundFetchPrices(), 1000); // Small delay to let server start
    }
    
  } catch (error) {
    console.error('❌ Error loading from database:', error.message);
    // Trigger immediate fetch on error
    setTimeout(() => backgroundFetchPrices(), 2000);
  }
}

// Set up background fetch interval
setInterval(() => {
  backgroundFetchPrices();
}, BACKGROUND_FETCH_INTERVAL);

// Health endpoint (for uptime monitoring)
app.get('/health', (req, res) => {
  const now = Date.now();
  const cacheAge = Math.floor((now - lastSuccessfulFetch) / 1000);
  const uptimeSeconds = Math.floor((now - serverStartTime) / 1000);
  
  db.get('SELECT COUNT(*) as count FROM price_cache', (err, row) => {
    res.json({ 
      success: true, 
      server_uptime_seconds: uptimeSeconds,
      server_uptime_minutes: Math.floor(uptimeSeconds / 60),
      message: 'PayCrypt Price API - Background Fetch Strategy!',
      margin: `+${MARGIN_NGN} NGN`,
      cache_age_seconds: cacheAge,
      cache_age_minutes: Math.floor(cacheAge / 60),
      last_successful_fetch: new Date(lastSuccessfulFetch).toISOString(),
      memory_cached_tokens: Object.keys(memoryCache).length,
      database_token_count: row ? row.count : 0,
      cache_status: Object.keys(memoryCache).length > 0 ? 'has_data' : 'empty',
      is_fetching: isFetching,
      total_fetch_attempts: fetchAttempts,
      background_fetch_interval_minutes: BACKGROUND_FETCH_INTERVAL / 60000,
      cache_fresh_threshold_minutes: CACHE_FRESH_DURATION / 60000,
      database_enabled: true
    });
  });
});

// Main price endpoint - ALWAYS serve from cache/database (no waiting)
app.get('/api/v3/simple/price', async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { ids, vs_currencies } = req.query;
    
    if (!ids) {
      return res.status(400).json({ error: 'Missing ids parameter' });
    }
    
    const requestedTokens = ids.split(',').map(id => id.trim());
    console.log(`📊 Request for: ${requestedTokens.join(', ')}`);
    
    // PRIORITY 1: Serve from memory cache (fastest)
    if (memoryCache && Object.keys(memoryCache).length > 0) {
      const filteredResult = {};
      let foundAllTokens = true;
      
      requestedTokens.forEach(tokenId => {
        if (memoryCache[tokenId]) {
          filteredResult[tokenId] = memoryCache[tokenId];
        } else {
          foundAllTokens = false;
        }
      });
      
      if (foundAllTokens && Object.keys(filteredResult).length > 0) {
        const cacheAge = Math.floor((Date.now() - lastSuccessfulFetch) / 60000);
        console.log(`💾 Serving from memory cache (${cacheAge} min old)`);
        logApiCall('/api/v3/simple/price', 'memory_cache_hit', Date.now() - startTime, requestedTokens.join(','));
        return res.json(filteredResult);
      }
    }
    
    // PRIORITY 2: Load from database
    try {
      console.log('🗄️ Loading from database...');
      const dbData = await loadFromDatabase(requestedTokens);
      
      if (Object.keys(dbData).length > 0) {
        // Update memory cache with database data
        memoryCache = { ...memoryCache, ...dbData };
        
        const filteredResult = {};
        requestedTokens.forEach(tokenId => {
          if (dbData[tokenId]) {
            filteredResult[tokenId] = dbData[tokenId];
          }
        });
        
        if (Object.keys(filteredResult).length > 0) {
          console.log(`🗄️ Serving from database (${Object.keys(filteredResult).length} tokens found)`);
          logApiCall('/api/v3/simple/price', 'database_hit', Date.now() - startTime, requestedTokens.join(','));
          return res.json(filteredResult);
        }
      }
    } catch (dbError) {
      console.error('❌ Database error:', dbError.message);
    }
    
    // PRIORITY 3: Emergency defaults (only for critical tokens)
    console.log('⚠️ Using emergency defaults - triggering background fetch');
    
    // Trigger background fetch if not already running
    if (!isFetching) {
      setTimeout(() => backgroundFetchPrices(), 100);
    }
    
    const defaultResult = {};
    
    requestedTokens.forEach(tokenId => {
      if (tokenId === 'tether' || tokenId === 'usd-coin') {
        defaultResult[tokenId] = {
          usd: 1.00,
          ngn: 1520 + MARGIN_NGN
        };
      } else if (tokenId === 'bitcoin') {
        defaultResult[tokenId] = {
          usd: 65000,
          ngn: (65000 * 1520) + MARGIN_NGN
        };
      } else if (tokenId === 'ethereum') {
        defaultResult[tokenId] = {
          usd: 3200,
          ngn: (3200 * 1520) + MARGIN_NGN
        };
      }
    });
    
    if (Object.keys(defaultResult).length > 0) {
      console.log('🚨 Serving emergency defaults');
      logApiCall('/api/v3/simple/price', 'emergency_defaults', Date.now() - startTime, requestedTokens.join(','));
      return res.json(defaultResult);
    }
    
    // Last resort
    logApiCall('/api/v3/simple/price', 'no_data_available', Date.now() - startTime, requestedTokens.join(','));
    res.status(503).json({
      error: 'Price data temporarily unavailable',
      message: 'Background fetch in progress. Please try again in a few seconds.',
      is_fetching: isFetching
    });
    
  } catch (error) {
    console.error('❌ Unexpected error:', error.message);
    logApiCall('/api/v3/simple/price', 'unexpected_error', Date.now() - startTime, error.message);
    
    res.status(500).json({
      error: 'Internal server error',
      message: 'Please try again later'
    });
  }
});

// Manual fetch trigger (for testing)
app.post('/fetch/trigger', async (req, res) => {
  if (isFetching) {
    return res.json({ message: 'Fetch already in progress', is_fetching: true });
  }
  
  backgroundFetchPrices();
  res.json({ message: 'Background fetch triggered', is_fetching: true });
});

// Database management endpoints
app.get('/database/stats', (req, res) => {
  db.all(`SELECT 
    token_id, 
    usd_price, 
    ngn_price, 
    datetime(last_updated/1000, 'unixepoch') as last_updated_human,
    (strftime('%s', 'now') * 1000 - last_updated) / 60000 as age_minutes
    FROM price_cache 
    ORDER BY last_updated DESC`, (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    
    res.json({
      total_tokens: rows.length,
      tokens: rows,
      memory_cache_count: Object.keys(memoryCache).length
    });
  });
});

app.get('/database/metrics', (req, res) => {
  db.all(`SELECT 
    status,
    COUNT(*) as count,
    AVG(response_time) as avg_response_time,
    datetime(MAX(timestamp)/1000, 'unixepoch') as last_occurrence
    FROM api_metrics 
    WHERE timestamp > ? 
    GROUP BY status
    ORDER BY count DESC`, [Date.now() - 24*60*60*1000], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    
    res.json({
      last_24_hours: rows,
      total_fetch_attempts: fetchAttempts
    });
  });
});

app.get('/fetch/logs', (req, res) => {
  db.all(`SELECT 
    datetime(timestamp/1000, 'unixepoch') as fetch_time,
    status,
    tokens_count,
    error_message,
    response_time
    FROM fetch_logs 
    ORDER BY timestamp DESC 
    LIMIT 20`, (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    
    res.json({
      recent_fetches: rows,
      total_attempts: fetchAttempts,
      is_currently_fetching: isFetching,
      last_successful_fetch: new Date(lastSuccessfulFetch).toISOString()
    });
  });
});

// Root endpoint
app.get('/', (req, res) => {
  const uptime = Math.floor((Date.now() - serverStartTime) / 1000);
  
  res.json({
    name: 'PayCrypt Price API - Background Fetch Strategy',
    description: 'Non-blocking API with background price fetching every 5 minutes',
    margin: `+${MARGIN_NGN} NGN`,
    server_uptime_seconds: uptime,
    features: {
      background_fetch: true,
      fetch_interval_minutes: BACKGROUND_FETCH_INTERVAL / 60000,
      database_persistence: true,
      memory_cache: true,
      non_blocking_api: true,
      emergency_fallbacks: true,
      cold_start_detection: true
    },
    status: {
      total_fetch_attempts: fetchAttempts,
      is_fetching: isFetching,
      cached_tokens: Object.keys(memoryCache).length,
      last_successful_fetch: new Date(lastSuccessfulFetch).toISOString()
    },
    usage: '/api/v3/simple/price?ids=tether,ethereum&vs_currencies=ngn,usd'
  });
});

// Initialize and start server
async function startServer() {
  await initializeCache();
  
  app.listen(PORT, () => {
    console.log(`🚀 PayCrypt Price API running on port ${PORT}`);
    console.log(`💰 Adding ${MARGIN_NGN} NGN margin to all prices`);
    console.log(`🗄️ DATABASE ENABLED: SQLite persistent storage`);
    console.log(`🔄 BACKGROUND FETCH: Every ${BACKGROUND_FETCH_INTERVAL/60000} minutes`);
    console.log(`⚡ NON-BLOCKING API: Always serves from cache/database`);
    console.log(`🎯 Strategy: Background fetch + instant cache responses`);
    console.log(`📊 Monitor with: /health, /fetch/logs, /database/stats`);
  });
}

startServer().catch(console.error);

module.exports = app;