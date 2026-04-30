import pool from '../config/database.js';

/**
 * Single SQL query that fetches all internal projects with their cutting plans
 * and attachments. Uses json_agg + subquery — no N+1.
 *
 * @returns {Promise<DbProject[]>}
 */
export async function fetchAllProjects() {
  const { rows } = await pool.query(`
    SELECT
      p.id,
      p.project,
      p.material_type,
      p.brand,
      p.model,
      p.roof_config,
      p.total_parts_qty,
      p.lid_parts_qty,
      p.created_at,
      COALESCE(
        json_agg(
          json_build_object(
            'id',                cp.id,
            'plate_width',       cp.plate_width,
            'plate_height',      cp.plate_height,
            'square_meters',     cp.square_meters,
            'linear_meters',     cp.linear_meters,
            'plate_consumption', cp.plate_consumption,
            'reviews',           cp.reviews,
            'attachments', (
              SELECT COALESCE(
                json_agg(
                  json_build_object(
                    'type', cpa.type,
                    'file', json_build_object(
                      'id',            fs.id,
                      'original_name', fs.original_name,
                      'mime_type',     fs.mime_type
                    )
                  )
                ),
                '[]'::json
              )
              FROM maestro.cutting_plan_attachment cpa
              JOIN maestro.file_storage fs ON fs.id = cpa.file_id
              WHERE cpa.cutting_plan_id = cp.id
            )
          ) ORDER BY cp.id
        ) FILTER (WHERE cp.id IS NOT NULL),
        '[]'::json
      ) AS cutting_plans
    FROM maestro.project p
    LEFT JOIN maestro.cutting_plan cp ON cp.project_id = p.id
    GROUP BY p.id
    ORDER BY p.project ASC
  `);

  return rows;
}

/**
 * Fetch specific projects by ID with file system paths included.
 * Used exclusively by the PDF generation endpoint.
 *
 * @param {number[]} ids
 * @returns {Promise<DbProjectWithPaths[]>}
 */
export async function fetchProjectsByIds(ids) {
  if (!ids.length) return [];

  const { rows } = await pool.query(`
    SELECT
      p.id,
      p.project,
      p.material_type,
      p.brand,
      p.model,
      p.roof_config,
      p.total_parts_qty,
      p.lid_parts_qty,
      COALESCE(
        json_agg(
          json_build_object(
            'id',                cp.id,
            'plate_width',       cp.plate_width,
            'plate_height',      cp.plate_height,
            'square_meters',     cp.square_meters,
            'linear_meters',     cp.linear_meters,
            'plate_consumption', cp.plate_consumption,
            'attachments', (
              SELECT COALESCE(
                json_agg(
                  json_build_object(
                    'type', cpa.type,
                    'file', json_build_object(
                      'id',   fs.id,
                      'name', fs.original_name,
                      'path', fs.path
                    )
                  )
                ),
                '[]'::json
              )
              FROM maestro.cutting_plan_attachment cpa
              JOIN maestro.file_storage fs ON fs.id = cpa.file_id
              WHERE cpa.cutting_plan_id = cp.id
            )
          ) ORDER BY cp.id
        ) FILTER (WHERE cp.id IS NOT NULL),
        '[]'::json
      ) AS cutting_plans
    FROM maestro.project p
    LEFT JOIN maestro.cutting_plan cp ON cp.project_id = p.id
    WHERE p.id = ANY($1::int[])
    GROUP BY p.id
    ORDER BY p.id
  `, [ids]);

  return rows;
}

/**
 * Fetch distinct plate dimensions from all cutting plans.
 * Returns sorted pairs formatted as { value: "1.60x3.00", label: "1,60m × 3,00m" }.
 *
 * @returns {Promise<{ value: string, label: string }[]>}
 */
export async function fetchDistinctDimensions() {
  const { rows } = await pool.query(`
    SELECT DISTINCT plate_width, plate_height
    FROM maestro.cutting_plan
    WHERE plate_width IS NOT NULL AND plate_height IS NOT NULL
    ORDER BY plate_width, plate_height
  `);

  return rows.map(({ plate_width, plate_height }) => {
    const w = (plate_width  / 1000).toFixed(2);
    const h = (plate_height / 1000).toFixed(2);
    return {
      value: `${w}x${h}`,
      label: `${w.replace('.', ',')}m × ${h.replace('.', ',')}m`,
    };
  });
}

/**
 * @typedef {Object} DbProject
 * @property {number}   id
 * @property {string}   project         - project code (e.g. "MP-1234")
 * @property {string}   material_type   - "ARAMIDA" | "TENSYLON"
 * @property {string}   brand
 * @property {string}   model
 * @property {string}   roof_config
 * @property {number}   total_parts_qty
 * @property {number}   lid_parts_qty
 * @property {Object[]} cutting_plans   - array of DbCuttingPlan
 */

/**
 * @typedef {Object} DbCuttingPlan
 * @property {number}   id
 * @property {number}   plate_width    - stored in millimeters
 * @property {number}   plate_height   - stored in millimeters
 * @property {Object}   square_meters
 * @property {Object}   linear_meters
 * @property {Object}   plate_consumption
 * @property {Object}   reviews        - { cutting: bool, labeling: bool, ki_Layout: bool, ... }
 * @property {Object[]} attachments    - [{ type: string, file: { id, original_name, mime_type } }]
 */
