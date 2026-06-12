const express = require('express')
const router = express.Router()

const fs = require('fs')
const path = require('path')

router.get('/', async (req, res) => {

  try {

    const complaintsDir =
      path.join(
        __dirname,
        '../uploads/complaints'
      )

    if (!fs.existsSync(complaintsDir)) {
      return res.json([])
    }

    const files =
      fs.readdirSync(complaintsDir)

    const pdfs =
      files
        .filter(
          file =>
            file.endsWith('.pdf')
        )
        .map(file => {

          // Extract CMP ID from filename
          // complaint_CMP_1779451858302.pdf
          // -> CMP_1779451858302

          const match =
            file.match(
              /complaint_(CMP_\d+)\.pdf/
            )

          const complaintId =
            match
              ? match[1]
              : 'UNKNOWN'

          return {

            id:
              complaintId,

            complaintId:
              complaintId,

            pdf:
              `http://localhost:5000/uploads/complaints/${file}`,

            severity:
              'HIGH',

            fileName:
              file,
          }
        })

    res.json(pdfs)

  } catch (err) {

    console.error(err)

    res.status(500).json({
      error:
        err.message,
    })
  }
})

module.exports = router