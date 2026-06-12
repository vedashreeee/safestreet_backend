const express = require('express')

const router = express.Router()

const pool = require('../db')

router.get('/', async (req, res) => {

  try {

    const {
      lat,
      lng,
      hazard,
    } = req.query

    if (!lat || !lng) {

      return res.json({
        success: false,
        count: 0,
      })
    }

    const result =
      await pool.query(
        `
        SELECT COUNT(*) AS count
        FROM reports
        WHERE
          hazard_type = $3
        AND
          SQRT(
            POWER(lat::numeric - $1::numeric, 2) +
            POWER(lng::numeric - $2::numeric, 2)
          ) < 0.0010
        `,
        [
          lat,
          lng,
          hazard,
        ]
      )

    const count =
      parseInt(
        result.rows[0].count
      )

    res.json({
      success: true,
      count,
    })

  } catch (err) {

    console.error(err)

    res.status(500).json({
      success: false,
      count: 0,
    })
  }
})

module.exports = router