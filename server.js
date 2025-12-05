const express = require('express');
const cors = require('cors');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || '';
const COINMARKETCAP_API_KEY = process.env.COINMARKETCAP_API_KEY || '';

// CORS configuration (unchanged)
app.use(cors({
  origin: [
    'https://paycryptv1.vercel.app',
    'https://admin.paycrypt.org',
    'https://www.paycrypt.org',
    'https://paycrypt.org',
    'http://localhost:5173',
    'https://miniapp.paycrypt.org',
    'https://paycrypt-admin-backend.onrender.com',
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
let lastRequestTime = 0;
let consecutiveFailures = 0;
let rateLimitedUntil = 0;

// Configuration
const BACKGROUND_FETCH_INTERVAL = 5 * 60 * 1000; // 5 minutes
const CACHE_FRESH_DURATION = 10 * 60 * 1000; // 10 minutes (consider fresh)
const CACHE_STALE_DURATION = 2 * 60 * 60 * 1000; // 2 hours (still usable)
const MIN_REQUEST_INTERVAL = 2 * 1000; // Minimum 2 seconds between CoinGecko requests (allows ~30 req/min)
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY = 10 * 1000; // 10 seconds

// Default tokens to always fetch
const DEFAULT_TOKENS = [
  'bitcoin', 'ethereum', 'tether', 'usd-coin', 'binancecoin', 
  'cardano', 'solana', 'polygon', 'chainlink', 'send-token-2',
  'celo-dollar', 'celo'
];

// Token symbol mapping for Alchemy API (CoinGecko ID -> Symbol)
// For Base mainnet tokens, we use contract addresses
const TOKEN_SYMBOL_MAP = {
  'bitcoin': 'BTC',
  'ethereum': 'ETH',
  'tether': 'USDT',
  'usd-coin': 'USDC',
  'binancecoin': 'BNB',
  'cardano': 'ADA',
  'solana': 'SOL',
  'polygon': 'MATIC',
  'chainlink': 'LINK',
  'send-token-2': 'SEND',  // SEND token on Base
  'celo-dollar': 'CUSD',
  'celo': 'CELO'
};

// Base mainnet contract addresses for tokens
const BASE_MAINNET_ADDRESSES = {
  'SEND': '0xeab49138ba2ea6dd776220fe26b7b8e446638956',
  'USDC': '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  'USDT': '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2'
};

// CoinMarketCap token IDs mapping
const COINMARKETCAP_ID_MAP = {
  'bitcoin': 1,
  'ethereum': 1027,
  'tether': 825,
  'usd-coin': 3408,
  'binancecoin': 1839,
  'cardano': 2010,
  'solana': 5426,
  'polygon': 3890,
  'chainlink': 1975,
  'send-token-2': 29382,  // SEND token ID on CoinMarketCap
  'celo-dollar': 5243,
  'celo': 5567
};

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

// Alchemy price fetching function
async function fetchPricesFromAlchemy(tokenIds) {
  if (!ALCHEMY_API_KEY) {
    throw new Error('Alchemy API key not configured');
  }

  const symbols = tokenIds
    .map(id => TOKEN_SYMBOL_MAP[id])
    .filter(symbol => symbol); // Filter out unmapped tokens

  if (symbols.length === 0) {
    throw new Error('No valid token symbols for Alchemy');
  }

  console.log(`🔷 Fetching prices from Alchemy for: ${symbols.join(', ')}`);
  console.log(`🔷 API Key configured: ${ALCHEMY_API_KEY ? 'Yes' : 'No'}`);

  const url = `https://api.g.alchemy.com/prices/v1/${ALCHEMY_API_KEY}/tokens/by-symbol`;
  
  try {
    console.log(`🔷 POST to: ${url}`);
    console.log(`🔷 Sending symbols: ${JSON.stringify(symbols)}`);
    
    // Build query parameters for symbols
    const params = new URLSearchParams();
    symbols.forEach(symbol => {
      params.append('symbols', symbol);
    });
    
    console.log(`🔷 Query params: ${params.toString()}`);
    
    const response = await axios.post(`${url}?${params.toString()}`, {}, {
      timeout: 30000,
      headers: {
        'Accept': 'application/json'
      }
    });

    console.log(`🔷 Alchemy response status: ${response.status}`);
    console.log(`🔷 Alchemy response type: ${typeof response.data}`);

    // Transform Alchemy response to match CoinGecko format
    const transformedData = {};
    
    // Alchemy returns { data: [ { symbol, prices: [{ value, currency }] } ] }
    let tokenDataArray = [];
    if (response.data && response.data.data && Array.isArray(response.data.data)) {
      tokenDataArray = response.data.data;
      console.log(`🔷 Response structure: data array with ${tokenDataArray.length} items`);
    } else if (Array.isArray(response.data)) {
      tokenDataArray = response.data;
      console.log(`🔷 Response structure: direct array with ${tokenDataArray.length} items`);
    }

    console.log(`🔷 Processing ${tokenDataArray.length} tokens from Alchemy response`);

    tokenDataArray.forEach((tokenData, index) => {
      // Find the token ID from symbol
      const tokenId = Object.keys(TOKEN_SYMBOL_MAP).find(
        key => TOKEN_SYMBOL_MAP[key] === tokenData.symbol
      );
      
      if (tokenId) {
        let usdPrice = null;
        
        // Alchemy format: prices array with {value, currency} objects
        if (tokenData.prices && Array.isArray(tokenData.prices)) {
          // Find USD price
          const usdPriceObj = tokenData.prices.find(p => p.currency === 'USD' || p.currency === 'usd');
          if (usdPriceObj && usdPriceObj.value) {
            usdPrice = usdPriceObj.value;
          } else if (tokenData.prices.length > 0 && tokenData.prices[0].value) {
            usdPrice = tokenData.prices[0].value;
          }
        } else if (tokenData.price) {
          usdPrice = tokenData.price;
        }
        
        if (usdPrice) {
          transformedData[tokenId] = {
            usd: parseFloat(usdPrice),
            ngn: null
          };
          console.log(`✅ ${tokenId} (${tokenData.symbol}): $${usdPrice}`);
        } else {
          console.log(`⚠️ ${tokenData.symbol}: No price found`);
        }
      } else {
        console.log(`⚠️ Unknown symbol: ${tokenData.symbol}`);
      }
    });

    console.log(`🔷 Alchemy returned ${Object.keys(transformedData).length} token prices`);
    
    // If we're missing SEND, try fetching it by contract address
    if (!transformedData['send-token-2'] && BASE_MAINNET_ADDRESSES['SEND']) {
      console.log(`🔷 SEND not found by symbol, trying by contract address...`);
      try {
        const contractAddr = BASE_MAINNET_ADDRESSES['SEND'];
        const addressParams = new URLSearchParams();
        addressParams.append('addresses', contractAddr);
        
        const contractResponse = await axios.post(
          `https://api.g.alchemy.com/prices/v1/${ALCHEMY_API_KEY}/tokens/by-address?chainId=8453&${addressParams.toString()}`,
          {},
          {
            timeout: 30000,
            headers: { 'Accept': 'application/json' }
          }
        );
        
        if (contractResponse.data && contractResponse.data.data && contractResponse.data.data.length > 0) {
          const sendData = contractResponse.data.data[0];
          if (sendData.prices && sendData.prices.length > 0) {
            const usdPrice = sendData.prices[0].value;
            transformedData['send-token-2'] = {
              usd: parseFloat(usdPrice),
              ngn: null
            };
            console.log(`✅ send-token-2 (SEND): $${usdPrice} [via contract address]`);
          }
        }
      } catch (contractError) {
        console.log(`⚠️ Contract address lookup failed: ${contractError.message}`);
      }
    }
    
    return transformedData;
  } catch (error) {
    console.error(`🔷 Alchemy API Error: ${error.message}`);
    if (error.response) {
      console.error(`🔷 Status: ${error.response.status}`);
      console.error(`🔷 Response type: ${typeof error.response.data}`);
      if (typeof error.response.data === 'string') {
        console.error(`🔷 Response (string): ${error.response.data.substring(0, 200)}`);
      } else {
        console.error(`🔷 Response (object):`, JSON.stringify(error.response.data).substring(0, 200));
      }
    }
    throw error;
  }
}

// Get NGN exchange rate and calculate NGN prices
async function calculateNGNPrices(tokenData) {
  try {
    // Try CoinMarketCap first for NGN rate if available
    if (COINMARKETCAP_API_KEY) {
      const cmcRate = await getNGNRateFromCoinMarketCap();
      if (cmcRate) {
        Object.keys(tokenData).forEach(tokenId => {
          if (tokenData[tokenId].usd && !tokenData[tokenId].ngn) {
            tokenData[tokenId].ngn = tokenData[tokenId].usd * cmcRate;
          }
        });
        console.log(`✅ NGN prices calculated using CoinMarketCap rate: ${cmcRate}`);
        return tokenData;
      }
    }
    
    // Fall back to CoinGecko for NGN rate
    console.log('📡 Fetching NGN rate from CoinGecko...');
    const response = await axios.get(
      'https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=ngn',
      { timeout: 10000 }
    );
    
    const usdToNgn = response.data?.tether?.ngn || 1520; // Fallback rate
    console.log(`✅ NGN rate from CoinGecko: ${usdToNgn}`);
    
    Object.keys(tokenData).forEach(tokenId => {
      if (tokenData[tokenId].usd && !tokenData[tokenId].ngn) {
        tokenData[tokenId].ngn = tokenData[tokenId].usd * usdToNgn;
      }
    });
  } catch (error) {
    console.warn('⚠️ Failed to fetch NGN rate (both CoinMarketCap and CoinGecko), using fallback: 1520');
    // Use fallback NGN rate
    Object.keys(tokenData).forEach(tokenId => {
      if (tokenData[tokenId].usd && !tokenData[tokenId].ngn) {
        tokenData[tokenId].ngn = tokenData[tokenId].usd * 1520;
      }
    });
  }
  
  return tokenData;
}

// Fetch prices from CoinMarketCap API (fallback #3)
async function fetchPricesFromCoinMarketCap(tokenIds) {
  if (!COINMARKETCAP_API_KEY) {
    throw new Error('CoinMarketCap API key not configured');
  }

  const cmcIds = tokenIds
    .map(id => COINMARKETCAP_ID_MAP[id])
    .filter(id => id);

  if (cmcIds.length === 0) {
    throw new Error('No valid CoinMarketCap IDs for tokens');
  }

  console.log(`🔶 Fetching prices from CoinMarketCap for ${cmcIds.length} tokens...`);

  const url = `https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?id=${cmcIds.join(',')}&convert=USD`;
  
  try {
    const response = await axios.get(url, {
      headers: {
        'X-CMC_PRO_API_KEY': COINMARKETCAP_API_KEY,
        'Accept': 'application/json'
      },
      timeout: 30000
    });

    const transformedData = {};
    const data = response.data?.data || {};
    
    console.log(`🔶 CoinMarketCap returned ${Object.keys(data).length} tokens`);

    // Map response back to CoinGecko IDs
    Object.entries(data).forEach(([cmcId, tokenData]) => {
      const tokenId = Object.keys(COINMARKETCAP_ID_MAP).find(
        key => COINMARKETCAP_ID_MAP[key] == cmcId
      );
      
      if (tokenId && tokenData.quote?.USD?.price) {
        transformedData[tokenId] = {
          usd: parseFloat(tokenData.quote.USD.price),
          ngn: null
        };
        console.log(`✅ ${tokenId}: $${tokenData.quote.USD.price}`);
      }
    });

    return transformedData;
  } catch (error) {
    console.error(`🔶 CoinMarketCap API Error: ${error.message}`);
    if (error.response) {
      console.error(`🔶 Status: ${error.response.status}`);
      console.error(`🔶 Response:`, error.response.data?.status?.error_message || error.response.data);
    }
    throw error;
  }
}

// Get NGN rate from CoinMarketCap (independent source for NGN conversion)
async function getNGNRateFromCoinMarketCap() {
  if (!COINMARKETCAP_API_KEY) {
    return null;
  }

  try {
    console.log('🔶 Fetching NGN rate from CoinMarketCap...');
    const url = `https://pro-api.coinmarketcap.com/v2/tools/price-conversion?amount=1&symbol=USD&convert=NGN`;
    
    const response = await axios.get(url, {
      headers: {
        'X-CMC_PRO_API_KEY': COINMARKETCAP_API_KEY,
        'Accept': 'application/json'
      },
      timeout: 10000
    });

    const rate = response.data?.data?.quote?.NGN?.value;
    if (rate) {
      console.log(`✅ CoinMarketCap NGN rate: 1 USD = ${rate} NGN`);
      return parseFloat(rate);
    }
  } catch (error) {
    console.error(`🔶 CoinMarketCap NGN rate fetch failed: ${error.message}`);
  }

  return null;
}

// Background fetch function with rate limiting and exponential backoff
async function backgroundFetchPrices(retryCount = 0) {
  if (isFetching) {
    console.log('⏳ Background fetch already in progress, skipping...');
    return;
  }

  // Check if we're rate limited
  const now = Date.now();
  if (now < rateLimitedUntil) {
    const waitMinutes = Math.ceil((rateLimitedUntil - now) / 60000);
    console.log(`⏸️ Rate limited. Waiting ${waitMinutes} more minute(s)...`);
    return;
  }

  // Enforce minimum time between requests
  const timeSinceLastRequest = now - lastRequestTime;
  if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
    const waitSeconds = Math.ceil((MIN_REQUEST_INTERVAL - timeSinceLastRequest) / 1000);
    console.log(`⏸️ Throttling: waiting ${waitSeconds}s before next request...`);
    return;
  }

  isFetching = true;
  fetchAttempts++;
  const startTime = Date.now();
  
  try {
    console.log(`🔄 Background fetch #${fetchAttempts} starting...`);
    
    lastRequestTime = Date.now();
    let originalData = {};
    let source = 'coingecko';
    
    // Try CoinGecko first
    try {
      const tokenList = DEFAULT_TOKENS.join(',');
      const coinGeckoUrl = `https://api.coingecko.com/api/v3/simple/price?ids=${tokenList}&vs_currencies=usd,ngn`;
      
      const response = await axios.get(coinGeckoUrl, {
        timeout: 30000,
        headers: {
          'User-Agent': 'PayCrypt-API/1.0',
          'Accept': 'application/json'
        }
      });
      
      originalData = response.data;
      console.log('✅ Fetched from CoinGecko');
    } catch (coinGeckoError) {
      const isCoinGeckoRateLimit = coinGeckoError.response && coinGeckoError.response.status === 429;
      
      if (isCoinGeckoRateLimit && ALCHEMY_API_KEY) {
        console.log('⚠️ CoinGecko rate limited, trying Alchemy...');
        
        // Try Alchemy as fallback
        try {
          originalData = await fetchPricesFromAlchemy(DEFAULT_TOKENS);
          // Calculate NGN prices from USD
          originalData = await calculateNGNPrices(originalData);
          source = 'alchemy';
          console.log('✅ Fetched from Alchemy');
        } catch (alchemyError) {
          console.error('❌ Alchemy fetch failed:', alchemyError.message);
          
          // Try CoinMarketCap as third fallback
          if (COINMARKETCAP_API_KEY) {
            console.log('⚠️ Alchemy failed, trying CoinMarketCap...');
            try {
              originalData = await fetchPricesFromCoinMarketCap(DEFAULT_TOKENS);
              
              // Try to get NGN rate from CoinMarketCap
              const cmcNgnRate = await getNGNRateFromCoinMarketCap();
              if (cmcNgnRate) {
                Object.keys(originalData).forEach(tokenId => {
                  if (originalData[tokenId].usd) {
                    originalData[tokenId].ngn = originalData[tokenId].usd * cmcNgnRate;
                  }
                });
              } else {
                // Fall back to CoinGecko rate or hardcoded fallback
                originalData = await calculateNGNPrices(originalData);
              }
              
              source = 'coinmarketcap';
              console.log('✅ Fetched from CoinMarketCap');
            } catch (cmcError) {
              console.error('❌ CoinMarketCap fetch failed:', cmcError.message);
              throw coinGeckoError; // Throw original CoinGecko error
            }
          } else {
            throw coinGeckoError; // Throw original CoinGecko error
          }
        }
      } else {
        throw coinGeckoError; // Re-throw if not rate limit or no Alchemy key
      }
    }
    
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
      consecutiveFailures = 0; // Reset failure counter on success
      
      // Save to database
      await saveToDatabase(modifiedData);
      
      const responseTime = Date.now() - startTime;
      console.log(`✅ Background fetch SUCCESS! Updated ${Object.keys(modifiedData).length} tokens from ${source} (${responseTime}ms)`);
      
      logFetchAttempt('success', Object.keys(modifiedData).length, `source: ${source}`, responseTime);
      
    } else {
      throw new Error('Empty response from CoinGecko');
    }
    
  } catch (error) {
    const responseTime = Date.now() - startTime;
    const isRateLimit = error.response && error.response.status === 429;
    
    if (isRateLimit) {
      consecutiveFailures++;
      // Exponential backoff: 5min, 10min, 30min, 60min
      const backoffMinutes = Math.min(5 * Math.pow(2, consecutiveFailures - 1), 60);
      rateLimitedUntil = Date.now() + (backoffMinutes * 60 * 1000);
      
      console.error(`🚫 RATE LIMITED (429) - Backing off for ${backoffMinutes} minutes`);
      console.log(`⏰ Next fetch attempt after: ${new Date(rateLimitedUntil).toISOString()}`);
      
      logFetchAttempt('rate_limited', 0, `Rate limited - backoff ${backoffMinutes}min`, responseTime);
    } else {
      console.error(`❌ Background fetch FAILED (attempt #${fetchAttempts}):`, error.message);
      logFetchAttempt('error', 0, error.message, responseTime);
      
      // Retry for non-rate-limit errors
      if (retryCount < MAX_RETRIES) {
        const retryDelay = INITIAL_RETRY_DELAY * Math.pow(2, retryCount);
        console.log(`🔄 Retrying in ${retryDelay/1000}s... (attempt ${retryCount + 1}/${MAX_RETRIES})`);
        setTimeout(() => backgroundFetchPrices(retryCount + 1), retryDelay);
      }
    }
    
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
  const isRateLimited = now < rateLimitedUntil;
  
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
      is_rate_limited: isRateLimited,
      rate_limit_expires: isRateLimited ? new Date(rateLimitedUntil).toISOString() : null,
      consecutive_failures: consecutiveFailures,
      total_fetch_attempts: fetchAttempts,
      background_fetch_interval_minutes: BACKGROUND_FETCH_INTERVAL / 60000,
      min_request_interval_seconds: MIN_REQUEST_INTERVAL / 1000,
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