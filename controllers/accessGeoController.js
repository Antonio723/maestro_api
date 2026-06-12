import pool from '../config/database.js';

// GET /api/audit/geo — consulta da localização (por IP) de quem acessou o site.
// Query params: limit, offset (lista recente) e days (janela das agregações).
// Retorna { recent, byCountry, byCity, totals, days }.
export const listAccessGeo = async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 30));
    const interval = `${days} days`;

    const recentQ = pool.query(
      `SELECT id, ip, city, region, country, country_code, lat, lon, isp,
              user_email, user_agent, path, created_at
         FROM maestro.access_geo
        ORDER BY created_at DESC
        LIMIT $1 OFFSET $2`,
      [limit, offset],
    );

    const byCountryQ = pool.query(
      `SELECT COALESCE(country, 'Desconhecido') AS country, country_code,
              COUNT(*) AS acessos, COUNT(DISTINCT ip) AS ips
         FROM maestro.access_geo
        WHERE created_at >= now() - $1::interval
        GROUP BY country, country_code
        ORDER BY acessos DESC
        LIMIT 50`,
      [interval],
    );

    const byCityQ = pool.query(
      `SELECT COALESCE(city, 'Desconhecida') AS city,
              COALESCE(region, '') AS region,
              COALESCE(country, '') AS country,
              COUNT(*) AS acessos, COUNT(DISTINCT ip) AS ips
         FROM maestro.access_geo
        WHERE created_at >= now() - $1::interval
        GROUP BY city, region, country
        ORDER BY acessos DESC
        LIMIT 50`,
      [interval],
    );

    const totalsQ = pool.query(
      `SELECT COUNT(*) AS acessos,
              COUNT(DISTINCT ip) AS ips,
              COUNT(DISTINCT country) FILTER (WHERE country IS NOT NULL) AS paises
         FROM maestro.access_geo
        WHERE created_at >= now() - $1::interval`,
      [interval],
    );

    const [recent, byCountry, byCity, totals] = await Promise.all([
      recentQ, byCountryQ, byCityQ, totalsQ,
    ]);

    return res.json({
      success: true,
      data: {
        recent: recent.rows,
        byCountry: byCountry.rows,
        byCity: byCity.rows,
        totals: totals.rows[0],
        days,
      },
    });
  } catch (error) {
    console.error('[accessGeo] list error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};
