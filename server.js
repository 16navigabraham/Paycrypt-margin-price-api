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

// Initialize database with enhanced schema
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS price_cache (
    token_id TEXT PRIMARY KEY,
    usd_price REAL,
    ngn_price REAL,
    original_ngn REAL,
    last_updated INTEGER,
    source TEXT DEFAULT 'coingecko',
    fetch_count INTEGER DEFAULT 1,
    priority INTEGER DEFAULT 0
  )`);
  
  // Track requested tokens that aren't cached
  db.run(`CREATE TABLE IF NOT EXISTS token_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_id TEXT,
    timestamp INTEGER,
    success BOOLEAN DEFAULT 0,
    INDEX(token_id, timestamp)
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
    response_time INTEGER,
    token_list TEXT
  )`);
});

// In-memory cache and tracking
let memoryCache = {};
let requestedTokensQueue = new Set(); // Track tokens requested by users
let pendingFetches = new Set(); // Track tokens currently being fetched
let lastSuccessfulFetch = 0;
let isFetching = false;
let fetchAttempts = 0;
let serverStartTime = Date.now();

// Configuration
const BACKGROUND_FETCH_INTERVAL = 3 * 60 * 1000; // 3 minutes (more frequent for dynamic tokens)
const CACHE_FRESH_DURATION = 5 * 60 * 1000; // 5 minutes (consider fresh)
const CACHE_STALE_DURATION = 2 * 60 * 60 * 1000; // 2 hours (still usable)
const MAX_TOKENS_PER_REQUEST = 100; // CoinGecko limit
const POPULAR_TOKENS_THRESHOLD = 5; // Requests needed to be considered popular

// Base popular tokens (always kept fresh)
const BASE_POPULAR_TOKENS = [
  'bitcoin', 'ethereum', 'tether', 'usd-coin', 'binancecoin'
];

// Enhanced database helper functions
function saveToDatabase(tokenData) {
  return new Promise((resolve, reject) => {
    const stmt = db.prepare(`INSERT OR REPLACE INTO price_cache 
      (token_id, usd_price, ngn_price, original_ngn, last_updated, source, fetch_count, priority) 
      VALUES (?, ?, ?, ?, ?, ?, 
        COALESCE((SELECT fetch_count FROM price_cache WHERE token_id = ?) + 1, 1),
        COALESCE((SELECT priority FROM price_cache WHERE token_id = ?), 0)
      )`);
    
    const timestamp = Date.now();
    
    Object.entries(tokenData).forEach(([tokenId, prices]) => {
      stmt.run([
        tokenId,
        prices.usd || null,
        prices.ngn || null,
        prices.ngn ? prices.ngn - MARGIN_NGN : null,
        timestamp,
        'coingecko',
        tokenId, // for fetch_count subquery
        tokenId  // for priority subquery
      ]);
    });
    
    stmt.finalize((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// Track token requests for popularity analysis
function trackTokenRequest(tokenId, success = false) {
  const stmt = db.prepare(`INSERT INTO token_requests (token_id, timestamp, success) VALUES (?, ?, ?)`);
  stmt.run([tokenId, Date.now(), success ? 1 : 0]);
  stmt.finalize();
}

// Get popular tokens based on request frequency
function getPopularTokens() {
  return new Promise((resolve, reject) => {
    const query = `
      SELECT token_id, COUNT(*) as request_count 
      FROM token_requests 
      WHERE timestamp > ? 
      GROUP BY token_id 
      HAVING request_count >= ? 
      ORDER BY request_count DESC 
      LIMIT 20
    `;
    
    const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
    
    db.all(query, [oneDayAgo, POPULAR_TOKENS_THRESHOLD], (err, rows) => {
      if (err) reject(err);
      else resolve(rows.map(row => row.token_id));
    });
  });
}

// Get tokens that need updating (stale cache)
function getStaleTokens() {
  return new Promise((resolve, reject) => {
    const staleThreshold = Date.now() - CACHE_FRESH_DURATION;
    
    db.all(`SELECT token_id FROM price_cache 
            WHERE last_updated < ? 
            ORDER BY priority DESC, fetch_count DESC, last_updated ASC 
            LIMIT 50`, 
    [staleThreshold], (err, rows) => {
      if (err) reject(err);
      else resolve(rows.map(row => row.token_id));
    });
  });
}

// Validate if token exists on CoinGecko (simple check)
async function validateTokenExists(tokenId) {
  try {
    const response = await axios.get(
      `https://api.coingecko.com/api/v3/simple/price?ids=${tokenId}&vs_currencies=usd`,
      { timeout: 5000 }
    );
    return Object.keys(response.data).length > 0;
  } catch (error) {
    return false;
  }
}

// Enhanced background fetch function
async function backgroundFetchPrices() {
  if (isFetching) {
    console.log('⏳ Background fetch already in progress, skipping...');
    return;
  }

  isFetching = true;
  fetchAttempts++;
  const startTime = Date.now();
  
  try {
    console.log(`🔄 Dynamic background fetch #${fetchAttempts} starting...`);
    
    // Get tokens to fetch (combination of strategies)
    const popularTokens = await getPopularTokens();
    const staleTokens = await getStaleTokens();
    const queuedTokens = Array.from(requestedTokensQueue);
    
    // Combine all token lists with priority
    const tokensToFetch = new Set([
      ...BASE_POPULAR_TOKENS,  // Always include base tokens
      ...popularTokens,        // Recently popular tokens
      ...queuedTokens,         // Currently requested tokens
      ...staleTokens.slice(0, 20) // Some stale tokens
    ]);
    
    // Clear the requested queue since we're processing it
    requestedTokensQueue.clear();
    
    if (tokensToFetch.size === 0) {
      console.log('📭 No tokens to fetch');
      return;
    }
    
    // Limit to prevent API rate limits
    const tokenList = Array.from(tokensToFetch).slice(0, MAX_TOKENS_PER_REQUEST);
    const tokenString = tokenList.join(',');
    
    console.log(`🎯 Fetching ${tokenList.length} tokens: ${tokenList.slice(0, 5).join(', ')}${tokenList.length > 5 ? '...' : ''}`);
    
    const coinGeckoUrl = `https://api.coingecko.com/api/v3/simple/price?ids=${tokenString}&vs_currencies=usd,ngn`;
    
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
      
      // Mark successful requests
      Object.keys(modifiedData).forEach(tokenId => {
        trackTokenRequest(tokenId, true);
      });
      
      const responseTime = Date.now() - startTime;
      console.log(`✅ Background fetch SUCCESS! Updated ${Object.keys(modifiedData).length} tokens (${responseTime}ms)`);
      
      logFetchAttempt('success', Object.keys(modifiedData).length, null, responseTime, tokenString);
      
    } else {
      throw new Error('Empty response from CoinGecko');
    }
    
  } catch (error) {
    const responseTime = Date.now() - startTime;
    console.error(`❌ Background fetch FAILED (attempt #${fetchAttempts}):`, error.message);
    logFetchAttempt('error', 0, error.message, responseTime, '');
  } finally {
    isFetching = false;
  }
}

// Enhanced main price endpoint - handles any token dynamically
app.get('/api/v3/simple/price', async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { ids, vs_currencies } = req.query;
    
    if (!ids) {
      return res.status(400).json({ error: 'Missing ids parameter' });
    }
    
    const requestedTokens = ids.split(',').map(id => id.trim().toLowerCase());
    console.log(`🔍 Request for: ${requestedTokens.join(', ')}`);
    
    // Track these tokens for future fetching
    requestedTokens.forEach(tokenId => {
      trackTokenRequest(tokenId, false);
      requestedTokensQueue.add(tokenId);
    });
    
    // PRIORITY 1: Serve from memory cache (fastest)
    const memoryResult = {};
    const missingTokens = [];
    
    requestedTokens.forEach(tokenId => {
      if (memoryCache[tokenId]) {
        memoryResult[tokenId] = memoryCache[tokenId];
      } else {
        missingTokens.push(tokenId);
      }
    });
    
    // If we found some tokens in memory, serve them immediately
    if (Object.keys(memoryResult).length > 0 && missingTokens.length === 0) {
      const cacheAge = Math.floor((Date.now() - lastSuccessfulFetch) / 60000);
      console.log(`💾 Serving ${Object.keys(memoryResult).length} tokens from memory cache (${cacheAge} min old)`);
      logApiCall('/api/v3/simple/price', 'memory_cache_hit', Date.now() - startTime, requestedTokens.join(','));
      return res.json(memoryResult);
    }
    
    // PRIORITY 2: Load missing tokens from database
    if (missingTokens.length > 0) {
      try {
        console.log(`🗄️ Loading ${missingTokens.length} missing tokens from database...`);
        const dbData = await loadFromDatabase(missingTokens);
        
        // Update memory cache with database data
        Object.assign(memoryCache, dbData);
        Object.assign(memoryResult, dbData);
        
        // Update missing tokens list
        missingTokens = missingTokens.filter(tokenId => !dbData[tokenId]);
        
      } catch (dbError) {
        console.error('❌ Database error:', dbError.message);
      }
    }
    
    // PRIORITY 3: For completely missing tokens, try immediate fetch (with rate limiting)
    if (missingTokens.length > 0 && missingTokens.length <= 10 && !isFetching) {
      console.log(`🚀 Attempting immediate fetch for missing tokens: ${missingTokens.join(', ')}`);
      
      try {
        const tokenString = missingTokens.join(',');
        const coinGeckoUrl = `https://api.coingecko.com/api/v3/simple/price?ids=${tokenString}&vs_currencies=usd,ngn`;
        
        const response = await axios.get(coinGeckoUrl, {
          timeout: 8000, // Shorter timeout for immediate requests
          headers: {
            'User-Agent': 'PayCrypt-API/1.0',
            'Accept': 'application/json'
          }
        });
        
        const originalData = response.data;
        
        if (originalData && Object.keys(originalData).length > 0) {
          const modifiedData = {};
          
          Object.entries(originalData).forEach(([tokenId, prices]) => {
            modifiedData[tokenId] = {
              ...prices,
              ngn: prices.ngn ? prices.ngn + MARGIN_NGN : prices.ngn
            };
          });
          
          // Update caches
          Object.assign(memoryCache, modifiedData);
          Object.assign(memoryResult, modifiedData);
          
          // Save to database
          await saveToDatabase(modifiedData);
          
          // Mark successful requests
          Object.keys(modifiedData).forEach(tokenId => {
            trackTokenRequest(tokenId, true);
          });
          
          console.log(`⚡ Immediate fetch SUCCESS! Got ${Object.keys(modifiedData).length} new tokens`);
        }
        
      } catch (fetchError) {
        console.error('⚠️ Immediate fetch failed:', fetchError.message);
        // Don't return error, continue with partial results
      }
    }
    
    // Return whatever we have (could be partial results)
    if (Object.keys(memoryResult).length > 0) {
      const foundCount = Object.keys(memoryResult).length;
      const totalCount = requestedTokens.length;
      
      console.log(`📊 Serving ${foundCount}/${totalCount} requested tokens`);
      
      // If we're missing tokens, trigger background fetch for next time
      if (foundCount < totalCount && !isFetching) {
        console.log('🔄 Triggering background fetch for missing tokens...');
        setTimeout(() => backgroundFetchPrices(), 1000);
      }
      
      logApiCall('/api/v3/simple/price', foundCount === totalCount ? 'complete_success' : 'partial_success', 
                Date.now() - startTime, requestedTokens.join(','));
      
      return res.json(memoryResult);
    }
    
    // PRIORITY 4: Emergency fallback for critical tokens
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
      
      // Trigger background fetch
      if (!isFetching) {
        setTimeout(() => backgroundFetchPrices(), 500);
      }
      
      return res.json(defaultResult);
    }
    
    // Last resort - no data available
    console.log('❌ No data available for requested tokens');
    
    // Trigger background fetch
    if (!isFetching) {
      setTimeout(() => backgroundFetchPrices(), 100);
    }
    
    logApiCall('/api/v3/simple/price', 'no_data_available', Date.now() - startTime, requestedTokens.join(','));
    
    res.status(404).json({
      error: 'Token data not found',
      message: 'The requested tokens were not found. Please check token IDs and try again in a few moments.',
      requested_tokens: requestedTokens,
      available_tokens_count: Object.keys(memoryCache).length,
      suggestion: 'Use CoinGecko token IDs (e.g., bitcoin, ethereum, cardano)'
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

// Token search/suggestion endpoint
app.get('/api/search/tokens', async (req, res) => {
  const { q } = req.query;
  
  if (!q || q.length < 2) {
    return res.status(400).json({ error: 'Query must be at least 2 characters' });
  }
  
  try {
    // Search in our cached tokens first
    db.all(`SELECT token_id, usd_price, ngn_price, fetch_count 
            FROM price_cache 
            WHERE token_id LIKE ? 
            ORDER BY fetch_count DESC 
            LIMIT 10`, 
    [`%${q.toLowerCase()}%`], (err, rows) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      
      res.json({
        query: q,
        cached_matches: rows,
        suggestion: 'For exact token IDs, visit CoinGecko API documentation'
      });
    });
    
  } catch (error) {
    res.status(500).json({ error: 'Search failed' });
  }
});

// Get popular/trending tokens
app.get('/api/popular/tokens', async (req, res) => {
  try {
    const popularTokens = await getPopularTokens();
    
    db.all(`SELECT token_id, usd_price, ngn_price, fetch_count, last_updated
            FROM price_cache 
            WHERE token_id IN (${popularTokens.map(() => '?').join(',') || 'NULL'})
            ORDER BY fetch_count DESC`, 
    popularTokens, (err, rows) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      
      res.json({
        popular_tokens: rows,
        base_tokens: BASE_POPULAR_TOKENS,
        update_frequency: `${BACKGROUND_FETCH_INTERVAL / 60000} minutes`
      });
    });
    
  } catch (error) {
    res.status(500).json({ error: 'Failed to get popular tokens' });
  }
});

// Rest of the helper functions remain the same but with enhanced logging
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

function logFetchAttempt(status, tokensCount = 0, errorMessage = null, responseTime = 0, tokenList = '') {
  const stmt = db.prepare(`INSERT INTO fetch_logs 
    (timestamp, status, tokens_count, error_message, response_time, token_list) 
    VALUES (?, ?, ?, ?, ?, ?)`);
  
  stmt.run([
    Date.now(),
    status,
    tokensCount,
    errorMessage,
    responseTime,
    tokenList
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

// Enhanced health endpoint
app.get('/health', (req, res) => {
  const now = Date.now();
  const cacheAge = Math.floor((now - lastSuccessfulFetch) / 1000);
  const uptimeSeconds = Math.floor((now - serverStartTime) / 1000);
  
  Promise.all([
    new Promise(resolve => db.get('SELECT COUNT(*) as count FROM price_cache', (err, row) => resolve(row?.count || 0))),
    getPopularTokens()
  ]).then(([dbCount, popular]) => {
    res.json({ 
      success: true, 
      server_uptime_seconds: uptimeSeconds,
      server_uptime_minutes: Math.floor(uptimeSeconds / 60),
      message: 'PayCrypt Dynamic Price API - Smart Fetching!',
      margin: `+${MARGIN_NGN} NGN`,
      cache_age_seconds: cacheAge,
      cache_age_minutes: Math.floor(cacheAge / 60),
      last_successful_fetch: new Date(lastSuccessfulFetch).toISOString(),
      memory_cached_tokens: Object.keys(memoryCache).length,
      database_token_count: dbCount,
      queued_tokens_count: requestedTokensQueue.size,
      popular_tokens_today: popular.length,
      cache_status: Object.keys(memoryCache).length > 0 ? 'has_data' : 'empty',
      is_fetching: isFetching,
      total_fetch_attempts: fetchAttempts,
      background_fetch_interval_minutes: BACKGROUND_FETCH_INTERVAL / 60000,
      cache_fresh_threshold_minutes: CACHE_FRESH_DURATION / 60000,
      features: {
        dynamic_tokens: true,
        immediate_fetch: true,
        popularity_tracking: true,
        smart_caching: true
      }
    });
  });
});

// Initialize cache and start server (same as before but with dynamic loading)
async function initializeCache() {
  console.log('🚀 SERVER STARTING - Dynamic Token Support Enabled');
  console.log(`📅 Server start time: ${new Date().toISOString()}`);
  
  try {
    console.log('📚 Loading cache from database...');
    const dbData = await loadFromDatabase();
    
    if (Object.keys(dbData).length > 0) {
      memoryCache = dbData;
      
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
      console.log('🔭 Database is empty - will fetch base tokens');
    }
    
    // Always trigger initial fetch for base tokens
    console.log('🔄 Triggering initial background fetch...');
    setTimeout(() => backgroundFetchPrices(), 2000);
    
  } catch (error) {
    console.error('❌ Error loading from database:', error.message);
    setTimeout(() => backgroundFetchPrices(), 3000);
  }
}

// Set up background fetch interval
setInterval(() => {
  backgroundFetchPrices();
}, BACKGROUND_FETCH_INTERVAL);

// Rest of endpoints remain similar with enhanced logging...
app.post('/fetch/trigger', async (req, res) => {
  if (isFetching) {
    return res.json({ message: 'Fetch already in progress', is_fetching: true });
  }
  
  backgroundFetchPrices();
  res.json({ message: 'Background fetch triggered', is_fetching: true });
});

app.get('/database/stats', (req, res) => {
  db.all(`SELECT 
    token_id, 
    usd_price, 
    ngn_price, 
    fetch_count,
    priority,
    datetime(last_updated/1000, 'unixepoch') as last_updated_human,
    (strftime('%s', 'now') * 1000 - last_updated) / 60000 as age_minutes
    FROM price_cache 
    ORDER BY fetch_count DESC, last_updated DESC 
    LIMIT 50`, (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    
    res.json({
      total_tokens: rows.length,
      tokens: rows,
      memory_cache_count: Object.keys(memoryCache).length,
      queued_tokens: Array.from(requestedTokensQueue)
    });
  });
});

// Root endpoint
app.get('/', (req, res) => {
  const uptime = Math.floor((Date.now() - serverStartTime) / 1000);
  
  res.json({
    name: 'PayCrypt Dynamic Price API',
    description: 'Smart price API that handles any token dynamically with intelligent caching',
    margin: `+${MARGIN_NGN} NGN`,
    server_uptime_seconds: uptime,
    features: {
      dynamic_token_support: true,
      immediate_fetch_for_missing: true,
      popularity_based_caching: true,
      smart_background_fetch: true,
      database_persistence: true,
      memory_cache: true,
      rate_limit_aware: true,
      partial_results: true
    },
    status: {
      total_fetch_attempts: fetchAttempts,
      is_fetching: isFetching,
      cached_tokens: Object.keys(memoryCache).length,
      queued_tokens: requestedTokensQueue.size,
      last_successful_fetch: new Date(lastSuccessfulFetch).toISOString()
    },
    endpoints: {
      prices: '/api/v3/simple/price?ids=bitcoin,ethereum,any-token&vs_currencies=ngn,usd',
      search: '/api/search/tokens?q=bitcoin',
      popular: '/api/popular/tokens',
      health: '/health'
    }
  });
});

// Start server
async function startServer() {
  await initializeCache();
  
  app.listen(PORT, () => {
    console.log(`🚀 PayCrypt Dynamic Price API running on port ${PORT}`);
    console.log(`💰 Adding ${MARGIN_NGN} NGN margin to all prices`);
    console.log(`🗄️ DATABASE ENABLED: SQLite with popularity tracking`);
    console.log(`🔄 DYNAMIC FETCHING: Any token, smart background updates`);
    console.log(`⚡ IMMEDIATE FETCH: Missing tokens fetched on-demand`);
    console.log(`🎯 SMART STRATEGY: Popularity-based + background + immediate fetch`);
    console.log(`📊 ENDPOINTS: /health, /api/search/tokens, /api/popular/tokens`);
  });
}

startServer().catch(console.error);

module.exports = app;