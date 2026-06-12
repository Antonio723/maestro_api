import jwt from 'jsonwebtoken';
import pool from '../config/database.js';
import { resolveGeo } from '../services/geoIpService.js';

// Registra a localização aproximada (por IP) de quem acessa a API, para a
// página de Auditoria > Localização. Nunca bloqueia nem atrasa a requisição:
// chama next() imediatamente e resolve/grava em segundo plano.
//
// Throttle por IP: no máximo 1 registro por IP a cada GEO_LOG_THROTTLE_MS
// (evita inflar a tabela e estourar o limite da API de geo). Default 15 min.
const THROTTLE_MS = Number(process.env.GEO_LOG_THROTTLE_MS) || 15 * 60 * 1000;
const MAX_MAP = 5000;
const lastSeen = new Map(); // ip -> timestamp do último registro

function clientIp(req) {
  let ip = req.ip || '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7); // IPv4 mapeado em IPv6
  return ip;
}

// IPs privados/loopback não têm geolocalização útil — não registra.
function isPrivate(ip) {
  if (!ip) return true;
  if (ip === '::1' || ip.startsWith('127.')) return true;
  if (ip.startsWith('10.') || ip.startsWith('192.168.')) return true;
  const m = ip.match(/^172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true; // ULA IPv6
  return false;
}

// Se houver um token válido, enriquece o registro com o e-mail do usuário.
function userEmailFromReq(req) {
  try {
    const parts = (req.headers.authorization || '').split(' ');
    if (parts.length === 2 && /^Bearer$/i.test(parts[0])) {
      const dec = jwt.verify(parts[1], process.env.JWT_SECRET);
      return dec?.email || null;
    }
  } catch {
    /* token inválido/expirado — registra como anônimo */
  }
  return null;
}

export function accessGeoLogger(req, res, next) {
  // Libera a requisição antes de qualquer trabalho de geo/IO.
  next();

  try {
    const ip = clientIp(req);
    if (isPrivate(ip)) return;

    const now = Date.now();
    const prev = lastSeen.get(ip);
    if (prev && now - prev < THROTTLE_MS) return;
    lastSeen.set(ip, now);

    if (lastSeen.size > MAX_MAP) {
      for (const [k, t] of lastSeen) {
        if (now - t > THROTTLE_MS) lastSeen.delete(k);
      }
    }

    const path = String(req.originalUrl || req.url || '').slice(0, 300);
    const ua = String(req.headers['user-agent'] || '').slice(0, 1000);
    const email = userEmailFromReq(req);

    resolveGeo(ip)
      .then((geo) =>
        pool.query(
          `INSERT INTO maestro.access_geo
             (ip, city, region, country, country_code, lat, lon, isp, user_email, user_agent, path)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            ip,
            geo?.city ?? null,
            geo?.region ?? null,
            geo?.country ?? null,
            geo?.countryCode ?? null,
            geo?.lat ?? null,
            geo?.lon ?? null,
            geo?.isp ?? null,
            email,
            ua,
            path,
          ],
        ),
      )
      .catch((err) => console.warn('[accessGeo] falha ao registrar acesso:', err.message));
  } catch (err) {
    console.warn('[accessGeo] erro inesperado:', err.message);
  }
}
