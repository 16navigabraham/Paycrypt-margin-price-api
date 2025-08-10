const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// CORS configuration
app.use(cors({
  origin: [
    'https://paycryptv1.vercel.app',
    'https://admin.paycrypt.org',
    'https://www.paycrypt.org',
    'https://paycrypt.org',
    'http://localhost:5173',
    'http://localhost:3000'
  ]
}));

// Your margin in Naira
const MARGIN_NGN = 20;

// Enhanced cache with longer duration to reduce API calls
let priceCache = {};
let lastUpdate = 0;
const CACHE_DURATION = 10 * 60 * 1000; // 10 minutes instead of 3
const MIN_REQUEST_INTERVAL = 60000; // 1 minute between CoinGecko calls

// Track request timing
let lastRequestTime = 0;

// Health endpoint
app.get('/health', (req, res) => {
  res.json({ 
    success: true, 
    message: 'CoinGecko-compatible API running!',
    margin: `+${MARGIN_NGN} NGN`,
    cache_age: Math.floor((Date.now() - lastUpdate) / 1000),
    cached_tokens: Object.keys(priceCache),
    cache_status: Object.keys(priceCache).length > 0 ? 'has_data' : 'empty'
  });
});

// CoinGecko-compatible endpoint with better rate limit handling
app.get('/api/v3/simple/price', async (req, res) => {
  try {
    const { ids, vs_currencies } = req.query;
    
    if (!ids) {
      return res.status(400).json({ error: 'Missing ids parameter' });
    }
    
    const now = Date.now();
    const cacheAge = now - lastUpdate;
    const timeSinceLastRequest = now - lastRequestTime;
    
    // Always try to serve from cache first if we have data
    if (priceCache && Object.keys(priceCache).length > 0) {
      const requestedTokens = ids.split(',').map(id => id.trim());
      const filteredResult = {};
      
      requestedTokens.forEach(tokenId => {
        if (priceCache[tokenId]) {
          filteredResult[tokenId] = priceCache[tokenId];
        }
      });
      
      // If we have all requested tokens in cache
      if (Object.keys(filteredResult).length === requestedTokens.length) {
        if (cacheAge < CACHE_DURATION) {
          console.log(`💾 Serving fresh cached data (${Math.floor(cacheAge/1000)}s old)`);
          return res.json(filteredResult);
        } else if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
          console.log(`⏰ Rate limit protection - serving stale cache (${Math.floor(cacheAge/1000)}s old)`);
          return res.json(filteredResult);
        }
      }
      
      // If we have some tokens but cache is stale and enough time has passed, try to refresh
      // But if refresh fails, we'll still serve stale data
    }
    
    // Only attempt fresh fetch if enough time has passed
    if (timeSinceLastRequest >= MIN_REQUEST_INTERVAL) {
      console.log(`🔄 Attempting fresh fetch for: ${ids}`);
      
      try {
        lastRequestTime = now;
        
        // Add longer delay to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        // Fetch from real CoinGecko with better headers
        const coinGeckoUrl = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=${vs_currencies}`;
        
        const response = await axios.get(coinGeckoUrl, {
          timeout: 30000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Accept': 'application/json',
            'Accept-Language': 'en-US,en;q=0.9',
            'Cache-Control': 'no-cache'
          }
        });
        
        const originalData = response.data;
        
        if (originalData && Object.keys(originalData).length > 0) {
          // Apply margin to NGN prices - keep EXACT CoinGecko format
          const modifiedData = {};
          
          Object.entries(originalData).forEach(([tokenId, prices]) => {
            modifiedData[tokenId] = {
              ...prices, // Keep all original fields (usd, etc.)
              ngn: prices.ngn ? prices.ngn + MARGIN_NGN : prices.ngn // Add margin only to NGN
            };
          });
          
          // Update cache
          priceCache = { ...priceCache, ...modifiedData };
          lastUpdate = now;
          
          console.log('✅ Fresh data fetched and cached successfully');
          console.log('💰 NGN prices with margin:', 
            Object.fromEntries(Object.entries(modifiedData).map(([token, prices]) => [token, prices.ngn]))
          );
          
          return res.json(modifiedData);
        }
      } catch (fetchError) {
        console.error(`❌ CoinGecko fetch error: ${fetchError.message}`);
        
        // Don't update lastRequestTime on failure so we can retry sooner
        lastRequestTime = lastRequestTime - (MIN_REQUEST_INTERVAL / 2);
        
        // Continue to serve stale cache below
      }
    } else {
      console.log(`⏰ Too soon since last request (${Math.floor(timeSinceLastRequest/1000)}s ago)`);
    }
    
    // Fallback: serve any available cache data
    if (Object.keys(priceCache).length > 0) {
      console.log('🆘 Serving stale cache data due to rate limits');
      
      const requestedTokens = ids.split(',').map(id => id.trim());
      const emergencyResult = {};
      
      requestedTokens.forEach(tokenId => {
        if (priceCache[tokenId]) {
          emergencyResult[tokenId] = priceCache[tokenId];
        }
      });
      
      if (Object.keys(emergencyResult).length > 0) {
        return res.json(emergencyResult);
      }
      
      // Return all cache if no specific matches
      return res.json(priceCache);
    }
    
    // Final fallback with default prices if no cache
    console.log('⚠️ No cache available, returning default values');
    const defaultTokens = ids.split(',').map(id => id.trim());
    const defaultResult = {};
    
    defaultTokens.forEach(tokenId => {
      // Provide reasonable default values
      if (tokenId === 'tether' || tokenId === 'usd-coin') {
        defaultResult[tokenId] = {
          usd: 1,
          ngn: 1650 + MARGIN_NGN // Default NGN rate + margin
        };
      } else if (tokenId === 'ethereum') {
        defaultResult[tokenId] = {
          usd: 3200,
          ngn: 5280000 + MARGIN_NGN
        };
      } else if (tokenId === 'bitcoin') {
        defaultResult[tokenId] = {
          usd: 45000,
          ngn: 74250000 + MARGIN_NGN
        };
      }
    });
    
    if (Object.keys(defaultResult).length > 0) {
      return res.json(defaultResult);
    }
    
    // Last resort
    res.status(503).json({
      error: 'Service temporarily unavailable',
      message: 'Price data temporarily unavailable due to rate limits. Please try again in a few minutes.',
      cached_tokens: Object.keys(priceCache)
    });
    
  } catch (error) {
    console.error('❌ Unexpected error:', error.message);
    
    // Even in unexpected errors, try to serve cache
    if (Object.keys(priceCache).length > 0) {
      console.log('🆘 Unexpected error - serving cache');
      return res.json(priceCache);
    }
    
    res.status(500).json({
      error: 'Internal server error',
      message: 'Please try again later'
    });
  }
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'PayCrypt Price API',
    description: 'CoinGecko-compatible API with NGN margin',
    margin: `+${MARGIN_NGN} NGN`,
    usage: '/api/v3/simple/price?ids=tether,ethereum&vs_currencies=ngn,usd',
    cache_info: {
      duration_minutes: CACHE_DURATION / 60000,
      min_interval_seconds: MIN_REQUEST_INTERVAL / 1000,
      cached_tokens: Object.keys(priceCache).length
    }
  });
});

// Cache management endpoint
app.get('/cache/info', (req, res) => {
  res.json({
    cache_age_seconds: Math.floor((Date.now() - lastUpdate) / 1000),
    cached_tokens: Object.keys(priceCache),
    cache_count: Object.keys(priceCache).length,
    last_update: new Date(lastUpdate).toISOString(),
    cache_valid: (Date.now() - lastUpdate) < CACHE_DURATION
  });
});

app.listen(PORT, () => {
  console.log(`🚀 PayCrypt Price API running on port ${PORT}`);
  console.log(`💰 Adding ${MARGIN_NGN} NGN margin to all prices`);
  console.log(`💾 Cache duration: ${CACHE_DURATION/1000/60} minutes`);
  console.log(`⏰ Min request interval: ${MIN_REQUEST_INTERVAL/1000} seconds`);
});

module.exports = app;