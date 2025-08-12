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
});

// In-memory cache (for speed) + Database (for persistence)
let memoryCache = {};
let lastUpdate = 0;
const CACHE_DURATION = 60 * 60 * 1000; // 1 HOUR
const MIN_REQUEST_INTERVAL = 20 * 60 * 1000; // 20 MINUTES (increased from 15)
const STALE_CACHE_DURATION = 48 * 60 * 60 * 1000; // 48 HOURS (increased from 24)

let lastRequestTime = 0;
let requestCount = 0;

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

// Load cache from database on startup
async function initializeCache() {
  try {
    console.log('📚 Loading cache from database...');
    const dbData = await loadFromDatabase();
    
    if (Object.keys(dbData).length > 0) {
      memoryCache = dbData;
      // Find the most recent update time
      db.get('SELECT MAX(last_updated) as latest FROM price_cache', (err, row) => {
        if (!err && row.latest) {
          lastUpdate = row.latest;
          const ageMinutes = Math.floor((Date.now() - row.latest) / 60000);
          console.log(`✅ Loaded ${Object.keys(dbData).length} tokens from database (${ageMinutes} min old)`);
        }
      });
    } else {
      console.log('📭 Database is empty - will fetch fresh data');
    }
  } catch (error) {
    console.error('❌ Error loading from database:', error.message);
  }
}

// Health endpoint with database info
app.get('/health', (req, res) => {
  const cacheAge = Math.floor((Date.now() - lastUpdate) / 1000);
  const timeSinceLastRequest = Math.floor((Date.now() - lastRequestTime) / 1000);
  
  db.get('SELECT COUNT(*) as count FROM price_cache', (err, row) => {
    res.json({ 
      success: true, 
      message: 'PayCrypt Price API - Database + Cache Strategy!',
      margin: `+${MARGIN_NGN} NGN`,
      cache_age_seconds: cacheAge,
      cache_age_hours: Math.floor(cacheAge / 3600),
      time_since_last_coingecko_call: timeSinceLastRequest,
      memory_cached_tokens: Object.keys(memoryCache),
      database_token_count: row ? row.count : 0,
      cache_status: Object.keys(memoryCache).length > 0 ? 'has_data' : 'empty',
      total_coingecko_requests: requestCount,
      next_refresh_in_minutes: Math.max(0, Math.floor((MIN_REQUEST_INTERVAL - (Date.now() - lastRequestTime)) / 60000)),
      database_enabled: true
    });
  });
});

// Enhanced price endpoint with database fallback
app.get('/api/v3/simple/price', async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { ids, vs_currencies } = req.query;
    
    if (!ids) {
      return res.status(400).json({ error: 'Missing ids parameter' });
    }
    
    const now = Date.now();
    const cacheAge = now - lastUpdate;
    const timeSinceLastRequest = now - lastRequestTime;
    const requestedTokens = ids.split(',').map(id => id.trim());
    
    console.log(`📊 Request for: ${requestedTokens.join(', ')}`);
    console.log(`⏰ Memory cache age: ${Math.floor(cacheAge/60000)} minutes | Time since last fetch: ${Math.floor(timeSinceLastRequest/60000)} minutes`);
    
    // PRIORITY 1: Serve from memory cache if fresh
    if (memoryCache && Object.keys(memoryCache).length > 0 && cacheAge < CACHE_DURATION) {
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
        console.log(`💾 Serving FRESH memory cache (${Math.floor(cacheAge/60000)} min old)`);
        logApiCall('/api/v3/simple/price', 'memory_cache_hit', Date.now() - startTime, requestedTokens.join(','));
        return res.json(filteredResult);
      }
    }
    
    // PRIORITY 2: Load from database if memory cache is stale/incomplete
    try {
      console.log('🗄️ Checking database for cached data...');
      const dbData = await loadFromDatabase(requestedTokens);
      
      if (Object.keys(dbData).length > 0) {
        // Update memory cache with database data
        memoryCache = { ...memoryCache, ...dbData };
        
        const filteredResult = {};
        let foundAllTokens = true;
        
        requestedTokens.forEach(tokenId => {
          if (dbData[tokenId]) {
            filteredResult[tokenId] = dbData[tokenId];
          } else {
            foundAllTokens = false;
          }
        });
        
        if (foundAllTokens && cacheAge < STALE_CACHE_DURATION) {
          console.log(`🗄️ Serving from DATABASE (${Object.keys(filteredResult).length} tokens found)`);
          logApiCall('/api/v3/simple/price', 'database_hit', Date.now() - startTime, requestedTokens.join(','));
          return res.json(filteredResult);
        }
        
        // If we have partial data and rate limited, serve what we have
        if (Object.keys(filteredResult).length > 0 && timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
          console.log(`🗄️ Serving partial DATABASE data due to rate limits`);
          logApiCall('/api/v3/simple/price', 'database_partial', Date.now() - startTime, requestedTokens.join(','));
          return res.json(filteredResult);
        }
      }
    } catch (dbError) {
      console.error('❌ Database error:', dbError.message);
    }
    
    // PRIORITY 3: Fetch from CoinGecko if allowed
    if (timeSinceLastRequest >= MIN_REQUEST_INTERVAL || Object.keys(memoryCache).length === 0) {
      console.log(`🔄 Attempting CoinGecko fetch (Request #${requestCount + 1})`);
      
      try {
        lastRequestTime = now;
        requestCount++;
        
        // Even longer delay to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 10000)); // 10 seconds
        
        const coinGeckoUrl = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=${vs_currencies}`;
        
        const response = await axios.get(coinGeckoUrl, {
          timeout: 45000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Cache-Control': 'no-cache'
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
          lastUpdate = now;
          
          // Save to database
          await saveToDatabase(modifiedData);
          
          console.log(`✅ SUCCESS! Fresh data cached in memory + database (Request #${requestCount})`);
          console.log('💰 NGN prices with +20 margin:', 
            Object.fromEntries(Object.entries(modifiedData).map(([token, prices]) => [token, prices.ngn]))
          );
          
          logApiCall('/api/v3/simple/price', 'coingecko_success', Date.now() - startTime, requestedTokens.join(','));
          return res.json(modifiedData);
        }
      } catch (fetchError) {
        console.error(`❌ CoinGecko error (Request #${requestCount}): ${fetchError.message}`);
        logApiCall('/api/v3/simple/price', 'coingecko_error', Date.now() - startTime, fetchError.message);
        
        // Reset request time to allow retry sooner on failure
        lastRequestTime = lastRequestTime - (MIN_REQUEST_INTERVAL * 0.3);
      }
    } else {
      const waitMinutes = Math.floor((MIN_REQUEST_INTERVAL - timeSinceLastRequest) / 60000);
      console.log(`⏰ RATE LIMITED - ${waitMinutes} minutes until next CoinGecko call allowed`);
    }
    
    // PRIORITY 4: Serve ANY available data (memory or database)
    let availableData = {};
    
    // Try memory first
    if (Object.keys(memoryCache).length > 0) {
      requestedTokens.forEach(tokenId => {
        if (memoryCache[tokenId]) {
          availableData[tokenId] = memoryCache[tokenId];
        }
      });
    }
    
    // Try database if memory doesn't have everything
    if (Object.keys(availableData).length < requestedTokens.length) {
      try {
        const dbData = await loadFromDatabase(requestedTokens);
        availableData = { ...availableData, ...dbData };
      } catch (dbError) {
        console.error('❌ Database fallback error:', dbError.message);
      }
    }
    
    if (Object.keys(availableData).length > 0) {
      console.log(`🆘 Serving STALE data (${Object.keys(availableData).length} tokens)`);
      logApiCall('/api/v3/simple/price', 'stale_data', Date.now() - startTime, Object.keys(availableData).join(','));
      return res.json(availableData);
    }
    
    // PRIORITY 5: Emergency defaults (last resort)
    console.log('⚠️ NO DATA AVAILABLE - Emergency defaults');
    const defaultResult = {};
    
    requestedTokens.forEach(tokenId => {
      if (tokenId === 'tether' || tokenId === 'usd-coin') {
        defaultResult[tokenId] = {
          usd: 1.00,
          ngn: 1520 + MARGIN_NGN
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
    logApiCall('/api/v3/simple/price', 'service_unavailable', Date.now() - startTime, requestedTokens.join(','));
    res.status(503).json({
      error: 'Service temporarily unavailable',
      message: `No price data available. Next CoinGecko retry in ${Math.floor((MIN_REQUEST_INTERVAL - (now - lastRequestTime)) / 60000)} minutes.`,
      next_retry_minutes: Math.floor((MIN_REQUEST_INTERVAL - (now - lastRequestTime)) / 60000)
    });
    
  } catch (error) {
    console.error('❌ Unexpected error:', error.message);
    logApiCall('/api/v3/simple/price', 'unexpected_error', Date.now() - startTime, error.message);
    
    // Try to serve any available data on errors
    try {
      const dbData = await loadFromDatabase();
      if (Object.keys(dbData).length > 0) {
        console.log('🆘 Error fallback - serving database data');
        return res.json(dbData);
      }
    } catch (dbError) {
      console.error('❌ Database fallback failed:', dbError.message);
    }
    
    res.status(500).json({
      error: 'Internal server error',
      message: 'Please try again later'
    });
  }
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
      total_coingecko_requests: requestCount
    });
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'PayCrypt Price API - Database + Cache Strategy',
    description: 'Persistent database storage with memory cache for reliability',
    margin: `+${MARGIN_NGN} NGN`,
    features: {
      database_persistence: true,
      memory_cache: true,
      fresh_cache_duration: '1 hour',
      stale_cache_tolerance: '48 hours',
      min_interval_between_calls: '20 minutes',
      coingecko_requests_made: requestCount
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
    console.log(`💾 DUAL CACHE: Memory (speed) + Database (persistence)`);
    console.log(`⏰ CoinGecko calls limited to every 20 minutes`);
    console.log(`🎯 Strategy: Database persistence + memory cache for reliability`);
  });
}

startServer().catch(console.error);

module.exports = app;