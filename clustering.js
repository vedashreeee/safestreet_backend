require('dotenv').config()

const { Pool } =
  require('pg')

// The fixed way: Import the pool we already fixed
const pool = require('./db'); 

const {
  generateComplaintPDF,
} = require('./pdfGenerator')
const fetch =
  require('node-fetch')

/* =========================================
   HAVERSINE
========================================= */

function haversineMeters(
  lat1,
  lng1,
  lat2,
  lng2
) {

  const R = 6371000

  const dLat =
    (lat2 - lat1) *
    Math.PI / 180

  const dLng =
    (lng2 - lng1) *
    Math.PI / 180

  const a =

    Math.sin(dLat / 2) *
    Math.sin(dLat / 2) +

    Math.cos(
      lat1 * Math.PI / 180
    ) *

    Math.cos(
      lat2 * Math.PI / 180
    ) *

    Math.sin(dLng / 2) *
    Math.sin(dLng / 2)

  return (
    R *
    2 *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a)
    )
  )
}
async function getLocationName(
  lat,
  lng
) {

  try {

    const res =
      await fetch(

        `https://nominatim.openstreetmap.org/reverse?` +

        `lat=${lat}` +

        `&lon=${lng}` +

        `&format=jsonv2` +

        `&zoom=19` +

        `&addressdetails=1`,

        {
          headers: {
            'User-Agent':
              'SafeStreet',

            'Accept-Language':
              'en'
          }
        }
      )

    const data =
      await res.json()

    const addr =
      data.address || {}

    const parts = [

      addr.road ||

      addr.pedestrian ||

      addr.neighbourhood,

      addr.suburb ||

      addr.village,

      addr.city ||

      addr.town ||

      addr.county

    ].filter(Boolean)

    return (

      parts.slice(0,3)
        .join(', ') ||

      `${lat.toFixed(5)}, ${lng.toFixed(5)}`
    )

  } catch {

    return
      `${lat.toFixed(5)}, ${lng.toFixed(5)}`
  }
}

/* =========================================
   DBSCAN
========================================= */

function dbscan(
  points,
  epsilon,
  minPts
) {

  const labels =
    new Array(points.length)
      .fill(-1)

  let clusterId = 0

  function getNeighbors(idx) {

    return points

      .map((p, i) => ({

        i,

        dist:
          haversineMeters(
            points[idx].lat,
            points[idx].lng,
            p.lat,
            p.lng
          ),
      }))

      .filter(
        ({ dist }) =>
          dist <= epsilon
      )

      .map(({ i }) => i)
  }

  function expandCluster(
    idx,
    neighbors
  ) {

    labels[idx] = clusterId

    let i = 0

    while (
      i < neighbors.length
    ) {

      const n =
        neighbors[i]

      if (
        labels[n] === -1
      ) {

        labels[n] =
          clusterId

        const newNeighbors =
          getNeighbors(n)

        if (
          newNeighbors.length >=
          minPts
        ) {

          neighbors.push(
            ...newNeighbors.filter(
              x =>
                !neighbors.includes(x)
            )
          )
        }
      }

      i++
    }
  }

  for (
    let i = 0;
    i < points.length;
    i++
  ) {

    if (
      labels[i] !== -1
    ) continue

    const neighbors =
      getNeighbors(i)

    if (
      neighbors.length < minPts
    ) {

      labels[i] = 0

    } else {

      clusterId++

      expandCluster(
        i,
        neighbors
      )
    }
  }

  return {
    labels
  }
}

/* =========================================
   MAIN
========================================= */

async function runClustering() {

  try {

    console.log(
      'Running clustering...'
    )

    const EPSILON = 20
    const MIN_PTS = 5

    const reportsResult =
      await pool.query(

        `
        SELECT
          id,
          report_id,
          lat::float,
          lng::float,
          hazard_type,
          photo_url,
          created_at
        FROM reports
        WHERE created_at >
        NOW() - INTERVAL '30 days'
        `
      )

    const reports =
      reportsResult.rows

    if (
      reports.length === 0
    ) return

    const {
      labels
    } = dbscan(
      reports,
      EPSILON,
      MIN_PTS
    )

    const clusters = {}

    reports.forEach(
      (r, i) => {

        const label =
          labels[i]

        if (
          label <= 0
        ) return

        if (
          !clusters[label]
        ) {

          clusters[label] = []
        }

        clusters[label]
          .push(r)
      }
    )

    for (
      const clusterReports
      of Object.values(
        clusters
      )
    ) {

      const count =
        clusterReports.length

      if (
        count <
        MIN_PTS
      ) continue

      const centerLat =
        clusterReports.reduce(
          (s,p)=>s+p.lat,
          0
        ) / count

      const centerLng =
        clusterReports.reduce(
          (s,p)=>s+p.lng,
          0
        ) / count

      const issues =
        [
          ...new Set(
            clusterReports.map(
              r =>
                r.hazard_type
            )
          )
        ]

      const severity =

        count >= 8
          ? 'critical'
          : 'verified'

      /* =====================================
         CHECK EXISTING ZONE
      ===================================== */

      const existingZones =
  await pool.query(

    `
    SELECT *
    FROM danger_zones
    `
  )

let existingZone =
  null

for (
  const zone
  of existingZones.rows
) {

  const dist =
    haversineMeters(

      centerLat,
      centerLng,

      Number(
        zone.center_lat
      ),

      Number(
        zone.center_lng
      )
    )

  if (
    dist <= 120
  ) {

    existingZone =
      zone

    break
  }
}

      /* =====================================
         EXISTING ZONE
      ===================================== */

      if (
  existingZone
) {

        const zone =
          existingZone

        console.log(
          'Existing zone found'
        )

        await pool.query(

          `
          UPDATE danger_zones
          SET
            report_count = $1,
            hazard_type = $2,
            severity = $3,
            updated_at = NOW()
          WHERE id = $4
          `,

          [
            count,
            issues.join(', '),
            severity,
            zone.id
          ]
        )

        for (
          const report
          of clusterReports
        ) {

          await pool.query(

  `
  UPDATE reports
  SET
    danger_zone_id = $1,
    location_name = $2
  WHERE id = $3
  `,

  [
  zone.id,
  zone.location_name,
  report.id
]
)      }

        console.log(
          'Zone updated — no new PDF'
        )

        continue
      }

      /* =====================================
         NEW ZONE
      ===================================== */

      console.log(
        'New zone created'
      )

      const clusterId =
        Math.floor(
          Math.random() *
          1000000
        )

      const pdfResult =
        await generateComplaintPDF({

          clusterId,

          centerLat,
          centerLng,

          hazardType:
            issues.join(', '),

          reportCount:
            count,

          reports:
            clusterReports,

          severity,
        })
const zoneLocation =
  await getLocationName(
    centerLat,
    centerLng
  )

console.log(
  '📍 Location:',
  zoneLocation
)     
const zoneInsert =
        await pool.query(

          `
INSERT INTO
danger_zones
(
  cluster_id,
  center_lat,
  center_lng,
  hazard_type,
  report_count,
  severity,
  status,
  complaint_pdf_url,
  location_name,
  created_at,
  updated_at
)
VALUES
(
  $1,$2,$3,$4,$5,
  $6,
  'open',
  $7,
  $8,
  NOW(),
  NOW()
)
RETURNING id
`,

          [
  clusterId,
  centerLat,
  centerLng,
  issues.join(', '),
  count,
  severity,
  pdfResult.relPath,
  zoneLocation
]
        )

      const zoneId =
        zoneInsert.rows[0].id

      for (
        const report
        of clusterReports
      ) {

        await pool.query(

          `
          UPDATE reports
SET
  danger_zone_id = $1,
  location_name = $2
WHERE id = $3
          `,

          [
  zoneId,
  zoneLocation,
  report.id
]
        )
      }

      console.log(
        'PDF generated once'
      )
    }

    console.log(
      'Clustering completed'
    )

  } catch (err) {

    console.error(
      err
    )
  }
}

module.exports = {
  runClustering,
}