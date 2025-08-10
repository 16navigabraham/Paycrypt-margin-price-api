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

// MAXIMIZED cache settings - serve CoinGecko data for much longer
let priceCache = {};
let lastUpdate = 0;
const CACHE_DURATION = 60 * 60 * 1000; // 1 HOUR cache (instead of 10 minutes)
const MIN_REQUEST_INTERVAL = 15 * 60 * 1000; // 15 MINUTES between CoinGecko calls (instead of 1 minute)
const STALE_CACHE_DURATION = 24 * 60 * 60 * 1000; // Serve stale data for up to 24 HOURS

// Track request timing
let lastRequestTime = 0;
let requestCount = 0;

// Health endpoint
app.get('/health', (req, res) => {
  const cacheAge = Math.floor((Date.now() - lastUpdate) / 1000);
  const timeSinceLastRequest = Math.floor((Date.now() - lastRequestTime) / 1000);
  
  res.json({ 
    success: true, 
    message: 'PayCrypt Price API - Long Cache Strategy!',
    margin: `+${MARGIN_NGN} NGN`,
    cache_age_seconds: cacheAge,
    cache_age_hours: Math.floor(cacheAge / 3600),
    time_since_last_coingecko_call: timeSinceLastRequest,
    cached_tokens: Object.keys(priceCache),
    cache_status: Object.keys(priceCache).length > 0 ? 'has_data' : 'empty',
    total_coingecko_requests: requestCount,
    next_refresh_in_minutes: Math.max(0, Math.floor((MIN_REQUEST_INTERVAL - (Date.now() - lastRequestTime)) / 60000))
  });
});

// CoinGecko-compatible endpoint with MAXIMUM cache duration
app.get('/api/v3/simple/price', async (req, res) => {
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
    console.log(`⏰ Cache age: ${Math.floor(cacheAge/60000)} minutes | Time since last fetch: ${Math.floor(timeSinceLastRequest/60000)} minutes`);
    
    // PRIORITY 1: Serve from cache if we have data (even if old)
    if (priceCache && Object.keys(priceCache).length > 0) {
      const filteredResult = {};
      let foundAllTokens = true;
      
      requestedTokens.forEach(tokenId => {
        if (priceCache[tokenId]) {
          filteredResult[tokenId] = priceCache[tokenId];
        } else {
          foundAllTokens = false;
        }
      });
      
      // If we have all requested tokens in cache
      if (foundAllTokens && Object.keys(filteredResult).length > 0) {
        if (cacheAge < CACHE_DURATION) {
          console.log(`💾 Serving FRESH cache (${Math.floor(cacheAge/60000)} min old)`);
          return res.json(filteredResult);
        } else if (cacheAge < STALE_CACHE_DURATION) {
          console.log(`🕒 Serving STALE cache (${Math.floor(cacheAge/60000)} min old) - avoiding CoinGecko calls`);
          
          // Only try to refresh if enough time passed AND we're not rate limited
          if (timeSinceLastRequest >= MIN_REQUEST_INTERVAL) {
            console.log(`🔄 Cache is stale but rate limit allows refresh - attempting background fetch`);
            // Continue to fetch section below, but serve cache first
          } else {
            // Rate limited, just serve stale cache
            console.log(`⏰ Rate limited - serving stale cache for ${Math.floor((MIN_REQUEST_INTERVAL - timeSinceLastRequest)/60000)} more minutes`);
            return res.json(filteredResult);
          }
        } else {
          console.log(`🚨 Cache is VERY old (${Math.floor(cacheAge/3600000)} hours) - will try to refresh`);
        }
      }
      
      // If we have partial data, serve it while potentially fetching missing tokens
      if (Object.keys(filteredResult).length > 0 && timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
        console.log(`📦 Serving partial cache data due to rate limits`);
        return res.json(filteredResult);
      }
    }
    
    // PRIORITY 2: Only fetch from CoinGecko if absolutely necessary
    if (timeSinceLastRequest >= MIN_REQUEST_INTERVAL || Object.keys(priceCache).length === 0) {
      console.log(`🔄 Attempting CoinGecko fetch (Request #${requestCount + 1})`);
      
      try {
        lastRequestTime = now;
        requestCount++;
        
        // Longer delay to be nice to CoinGecko
        await new Promise(resolve => setTimeout(resolve, 8000)); // 8 seconds
        
        const coinGeckoUrl = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=${vs_currencies}`;
        
        const response = await axios.get(coinGeckoUrl, {
          timeout: 45000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Cache-Control': 'no-cache',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'cross-site'
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
          
          // Update cache with fresh data
          priceCache = { ...priceCache, ...modifiedData };
          lastUpdate = now;
          
          console.log(`✅ SUCCESS! Fresh data cached for 1 HOUR (Request #${requestCount})`);
          console.log('💰 NGN prices with +20 margin:', 
            Object.fromEntries(Object.entries(modifiedData).map(([token, prices]) => [token, prices.ngn]))
          );
          
          return res.json(modifiedData);
        }
      } catch (fetchError) {
        console.error(`❌ CoinGecko error (Request #${requestCount}): ${fetchError.message}`);
        
        // Reset request time to allow retry sooner on failure
        lastRequestTime = lastRequestTime - (MIN_REQUEST_INTERVAL * 0.5);
        
        // Fall through to serve cache or defaults
      }
    } else {
      const waitMinutes = Math.floor((MIN_REQUEST_INTERVAL - timeSinceLastRequest) / 60000);
      console.log(`⏰ RATE LIMITED - ${waitMinutes} minutes until next CoinGecko call allowed`);
    }
    
    // PRIORITY 3: Serve ANY available cache (even very stale)
    if (Object.keys(priceCache).length > 0) {
      console.log(`🆘 Serving EMERGENCY cache (${Math.floor(cacheAge/60000)} min old)`);
      
      const filteredResult = {};
      requestedTokens.forEach(tokenId => {
        if (priceCache[tokenId]) {
          filteredResult[tokenId] = priceCache[tokenId];
        }
      });
      
      if (Object.keys(filteredResult).length > 0) {
        return res.json(filteredResult);
      }
      
      // Return all cache if no specific matches
      return res.json(priceCache);
    }
    
    // PRIORITY 4: Only use defaults if absolutely no cache exists
    console.log('⚠️ NO CACHE - Emergency defaults (avoid this!)');
    const defaultResult = {};
    
    requestedTokens.forEach(tokenId => {
      if (tokenId === 'tether' || tokenId === 'usd-coin') {
        defaultResult[tokenId] = {
          usd: 1.00,
          ngn: 1650 + MARGIN_NGN
        };
      } else if (tokenId === 'ethereum') {
        defaultResult[tokenId] = {
          usd: 3200,
          ngn: (3200 * 1650) + MARGIN_NGN
        };
      }
    });
    
    if (Object.keys(defaultResult).length > 0) {
      console.log('🚨 Serving emergency defaults - cache was empty!');
      return res.json(defaultResult);
    }
    
    // Last resort
    res.status(503).json({
      error: 'Service temporarily unavailable',
      message: `No price data available. Next CoinGecko retry in ${Math.floor((MIN_REQUEST_INTERVAL - (now - lastRequestTime)) / 60000)} minutes.`,
      next_retry_minutes: Math.floor((MIN_REQUEST_INTERVAL - (now - lastRequestTime)) / 60000)
    });
    
  } catch (error) {
    console.error('❌ Unexpected error:', error.message);
    
    // Always try to serve cache on errors
    if (Object.keys(priceCache).length > 0) {
      console.log('🆘 Error fallback - serving cache');
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
    name: 'PayCrypt Price API - Long Cache Strategy',
    description: 'Maximized cache duration to minimize CoinGecko calls',
    margin: `+${MARGIN_NGN} NGN`,
    cache_strategy: {
      fresh_cache_duration: '1 hour',
      stale_cache_tolerance: '24 hours',
      min_interval_between_calls: '15 minutes',
      coingecko_requests_made: requestCount
    },
    usage: '/api/v3/simple/price?ids=tether,ethereum&vs_currencies=ngn,usd'
  });
});

// Cache management endpoints
app.get('/cache/info', (req, res) => {
  const now = Date.now();
  const cacheAge = now - lastUpdate;
  
  res.json({
    cache_age_minutes: Math.floor(cacheAge / 60000),
    cache_age_hours: Math.floor(cacheAge / 3600000),
    cached_tokens: Object.keys(priceCache),
    cache_count: Object.keys(priceCache).length,
    last_update: lastUpdate ? new Date(lastUpdate).toISOString() : 'never',
    fresh_cache: cacheAge < CACHE_DURATION,
    stale_but_usable: cacheAge < STALE_CACHE_DURATION,
    coingecko_requests_made: requestCount,
    next_refresh_allowed: new Date(lastRequestTime + MIN_REQUEST_INTERVAL).toISOString(),
    cache_data: priceCache
  });
});

app.get('/cache/force-refresh', async (req, res) => {
  try {
    console.log('🔄 Manual cache refresh triggered');
    
    // Reset timing to allow immediate fetch
    lastRequestTime = 0;
    
    // Trigger a refresh by making a request
    const response = await axios.get(`http://localhost:${PORT}/api/v3/simple/price?ids=tether,usd-coin,ethereum&vs_currencies=ngn,usd`);
    
    res.json({
      success: true,
      message: 'Cache refresh triggered',
      new_data: response.data
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Refresh failed',
      message: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 PayCrypt Price API running on port ${PORT}`);
  console.log(`💰 Adding ${MARGIN_NGN} NGN margin to all prices`);
  console.log(`💾 MAXIMIZED CACHE: Fresh for 1 hour, stale tolerance 24 hours`);
  console.log(`⏰ CoinGecko calls limited to every 15 minutes`);
  console.log(`🎯 Strategy: Minimize CoinGecko calls, maximize cache usage`);
});

module.exports = app;