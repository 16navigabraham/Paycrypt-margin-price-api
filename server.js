const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// CORS configuration
const corsOptions = {
  origin: [
    'https://paycryptv1.vercel.app',
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:5173',
    'http://127.0.0.1:3000'
  ],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
};

app.use(cors(corsOptions));

// Your margin in Naira
const MARGIN_NGN = 10;

// Enhanced caching with longer duration
let globalCache = {};
let lastFetchTime = 0;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes cache
const MIN_REQUEST_INTERVAL = 30000; // 30 seconds between CoinGecko calls

// Health check endpoint
app.get('/health', (req, res) => {
  const cacheAge = Date.now() - lastFetchTime;
  res.json({ 
    success: true, 
    message: 'PayCrypt Margin API is running! 🚀',
    margin: `Adding ${MARGIN_NGN} NGN to all prices`,
    cache_status: {
      has_data: Object.keys(globalCache).length > 0,
      cache_age_seconds: Math.floor(cacheAge / 1000),
      cache_valid: cacheAge < CACHE_DURATION
    },
    timestamp: new Date().toISOString()
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    success: true,
    name: 'PayCrypt Margin Price API',
    description: 'Crypto prices with NGN margin',
    version: '1.0.0',
    endpoints: {
      health: '/health',
      prices: '/api/v3/simple/price?ids=tether,usd-coin,ethereum&vs_currencies=ngn,usd'
    }
  });
});

// Function to fetch from multiple sources if needed
async function fetchPricesWithFallback(tokenIds, currencies) {
  const ids = tokenIds.join(',');
  
  // Primary: CoinGecko API
  try {
    console.log(`🔄 Attempting CoinGecko fetch for: ${ids}`);
    
    const response = await axios.get(`https://api.coingecko.com/api/v3/simple/price`, {
      params: {
        ids: ids,
        vs_currencies: currencies,
        include_24hr_change: false
      },
      timeout: 25000,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; PayCrypt/1.0)'
      }
    });
    
    if (response.data && Object.keys(response.data).length > 0) {
      console.log('✅ CoinGecko fetch successful');
      return response.data;
    }
  } catch (error) {
    console.log(`⚠️ CoinGecko failed: ${error.message}`);
    
    // If rate limited, try with longer delay
    if (error.response?.status === 429) {
      console.log('⏳ Rate limited, trying fallback approach...');
      
      // Try fetching tokens one by one with delays
      const results = {};
      for (const tokenId of tokenIds) {
        try {
          await new Promise(resolve => setTimeout(resolve, 10000)); // 10s delay between tokens
          const singleResponse = await axios.get(`https://api.coingecko.com/api/v3/simple/price`, {
            params: {
              ids: tokenId,
              vs_currencies: currencies
            },
            timeout: 30000,
            headers: {
              'User-Agent': 'Mozilla/5.0 (compatible; PayCrypt/1.0)'
            }
          });
          
          if (singleResponse.data[tokenId]) {
            results[tokenId] = singleResponse.data[tokenId];
            console.log(`✅ Fetched ${tokenId} individually`);
          }
        } catch (singleError) {
          console.log(`❌ Failed to fetch ${tokenId}: ${singleError.message}`);
        }
      }
      
      if (Object.keys(results).length > 0) {
        return results;
      }
    }
  }
  
  // If all fails, return null
  throw new Error('All fetch attempts failed');
}

// Main endpoint
app.get('/api/v3/simple/price', async (req, res) => {
  try {
    const { ids, vs_currencies = 'ngn,usd' } = req.query;
    
    if (!ids) {
      return res.status(400).json({
        error: 'Missing ids parameter',
        example: '/api/v3/simple/price?ids=tether,ethereum&vs_currencies=ngn,usd'
      });
    }
    
    const tokenIds = ids.split(',').map(id => id.trim());
    const now = Date.now();
    
    // Check if we have valid cached data
    const cacheAge = now - lastFetchTime;
    const hasValidCache = Object.keys(globalCache).length > 0 && cacheAge < CACHE_DURATION;
    
    if (hasValidCache) {
      console.log(`💾 Serving cached data (${Math.floor(cacheAge/1000)}s old)`);
      
      // Filter cached data for requested tokens
      const cachedResults = {};
      tokenIds.forEach(tokenId => {
        if (globalCache[tokenId]) {
          cachedResults[tokenId] = globalCache[tokenId];
        }
      });
      
      if (Object.keys(cachedResults).length > 0) {
        return res.json(cachedResults);
      }
    }
    
    // Check minimum interval between requests
    const timeSinceLastFetch = now - lastFetchTime;
    if (timeSinceLastFetch < MIN_REQUEST_INTERVAL && Object.keys(globalCache).length > 0) {
      console.log(`⏰ Too soon since last fetch (${Math.floor(timeSinceLastFetch/1000)}s ago), serving cache`);
      const cachedResults = {};
      tokenIds.forEach(tokenId => {
        if (globalCache[tokenId]) {
          cachedResults[tokenId] = globalCache[tokenId];
        }
      });
      return res.json(cachedResults);
    }
    
    console.log(`📊 Fetching fresh data for: ${ids}`);
    
    // Fetch new data
    const originalData = await fetchPricesWithFallback(tokenIds, vs_currencies);
    
    if (!originalData || Object.keys(originalData).length === 0) {
      // Return stale cache if available
      if (Object.keys(globalCache).length > 0) {
        console.log('⚠️ No fresh data, serving stale cache');
        const staleResults = {};
        tokenIds.forEach(tokenId => {
          if (globalCache[tokenId]) {
            staleResults[tokenId] = globalCache[tokenId];
          }
        });
        return res.json(staleResults);
      }
      
      return res.status(503).json({
        error: 'Service temporarily unavailable',
        message: 'Unable to fetch price data at the moment'
      });
    }
    
    // Process and cache the data
    const processedData = {};
    
    Object.entries(originalData).forEach(([tokenId, prices]) => {
      processedData[tokenId] = {
        usd: prices.usd,
        ngn: prices.ngn ? prices.ngn + MARGIN_NGN : prices.ngn
      };
      
      // Update global cache
      globalCache[tokenId] = processedData[tokenId];
    });
    
    lastFetchTime = now;
    
    console.log(`✅ Successfully processed ${Object.keys(processedData).length} tokens`);
    console.log('💰 NGN prices with margin:', 
      Object.fromEntries(Object.entries(processedData).map(([token, prices]) => [token, prices.ngn]))
    );
    
    res.json(processedData);
    
  } catch (error) {
    console.error('❌ Error in main endpoint:', error.message);
    
    // Try to serve any available cached data
    if (Object.keys(globalCache).length > 0) {
      console.log('🆘 Error occurred, serving any available cached data');
      const { ids } = req.query;
      const tokenIds = ids ? ids.split(',').map(id => id.trim()) : [];
      
      const emergency = {};
      tokenIds.forEach(tokenId => {
        if (globalCache[tokenId]) {
          emergency[tokenId] = globalCache[tokenId];
        }
      });
      
      if (Object.keys(emergency).length > 0) {
        return res.json({
          ...emergency,
          _warning: 'Using cached data due to API issues',
          _cache_age: Math.floor((Date.now() - lastFetchTime) / 1000)
        });
      }
    }
    
    res.status(500).json({
      error: 'Failed to fetch prices',
      message: 'Service temporarily unavailable. Please try again in a few minutes.',
      retry_after: 60
    });
  }
});

// Cache info endpoint
app.get('/cache/info', (req, res) => {
  const cacheAge = Date.now() - lastFetchTime;
  res.json({
    success: true,
    cache: {
      tokens: Object.keys(globalCache),
      count: Object.keys(globalCache).length,
      age_seconds: Math.floor(cacheAge / 1000),
      valid: cacheAge < CACHE_DURATION,
      last_fetch: new Date(lastFetchTime).toISOString()
    }
  });
});

// Catch all
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: `${req.method} ${req.originalUrl} not found`,
    available: ['GET /', 'GET /health', 'GET /api/v3/simple/price']
  });
});

app.listen(PORT, () => {
  console.log(`🚀 PayCrypt Margin API running on port ${PORT}`);
  console.log(`💰 NGN margin: +${MARGIN_NGN}`);
  console.log(`💾 Cache duration: ${CACHE_DURATION/1000/60} minutes`);
  console.log(`⏰ Min request interval: ${MIN_REQUEST_INTERVAL/1000} seconds`);
});

module.exports = app;