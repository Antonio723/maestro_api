import axios from 'axios';

// Resolve um IP em localização aproximada (cidade/estado/país) via ip-api.com —
// grátis, sem chave, HTTP, limite de ~45 req/min por IP de origem. Não pede
// permissão ao usuário (geolocalização por IP, não por GPS).
//
// Pluggable: para trocar por uma base offline (MaxMind GeoLite2) depois, basta
// reimplementar `resolveGeo` mantendo o mesmo formato de retorno.
const GEO_TIMEOUT_MS = Number(process.env.GEOIP_TIMEOUT_MS) || 3000;
const FIELDS = 'status,message,country,countryCode,regionName,city,lat,lon,isp,query';

export async function resolveGeo(ip) {
  if (!ip) return null;
  try {
    const { data } = await axios.get(`http://ip-api.com/json/${encodeURIComponent(ip)}`, {
      params: { fields: FIELDS },
      timeout: GEO_TIMEOUT_MS,
    });
    if (!data || data.status !== 'success') return null;
    return {
      city: data.city || null,
      region: data.regionName || null,
      country: data.country || null,
      countryCode: data.countryCode || null,
      lat: typeof data.lat === 'number' ? data.lat : null,
      lon: typeof data.lon === 'number' ? data.lon : null,
      isp: data.isp || null,
    };
  } catch {
    // Falha de rede / rate limit / timeout — registra o acesso sem geo.
    return null;
  }
}
