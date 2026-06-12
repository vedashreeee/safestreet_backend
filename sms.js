// sms.js — Twilio SMS sender for SafeStreet
require('dotenv').config()

const accountSid = process.env.TWILIO_ACCOUNT_SID
const authToken  = process.env.TWILIO_AUTH_TOKEN
const fromNumber = process.env.TWILIO_PHONE_NUMBER

// ── Message templates ──────────────────────────────────────
const TEMPLATES = {

  // Sent when report is submitted
  confirmation: (reportId, hazardType) =>
    `SafeStreet: మీ నివేదన నమోదైంది (${reportId}). ` +
    `సమస్య: ${hazardType}. ` +
    `5 మంది ఇదే స్థానాన్ని నివేదిస్తే పంచాయతీకి ఫిర్యాదు పంపబడుతుంది. ` +
    `SafeStreet - Tadigadapa Municipality`,

  // Sent when danger zone is created and complaint PDF generated
  complaint_generated: (hazardType, location) =>
    `SafeStreet: ${location} వద్ద ${hazardType} సమస్య నిర్ధారించబడింది. ` +
    `అధికారిక ఫిర్యాదు పంచాయతీకి పంపబడింది. ` +
    `త్వరలో మరమ్మతు జరుగుతుంది. ` +
    `SafeStreet - Tadigadapa Municipality`,

  // Sent when issue is marked as solved
  resolved: (hazardType, location) =>
    `SafeStreet: శుభవార్త! ${location} వద్ద ${hazardType} సమస్య పరిష్కరించబడింది. ` +
    `మీ నివేదన కోసం ధన్యవాదాలు. ` +
    `SafeStreet - Tadigadapa Municipality`,
}

// ── Main send function ──────────────────────────────────────
async function sendSMS(toPhone, templateType, data = {}) {

  // Skip if Twilio not configured
  if (!accountSid || !authToken || !fromNumber) {
    console.log(`📵 SMS skipped (Twilio not configured)`)
    console.log(`   Would send: ${templateType} to ${toPhone}`)
    return { skipped: true }
  }

  // Validate phone number
  if (!toPhone || toPhone.length < 10) {
    console.log(`📵 SMS skipped — invalid phone: ${toPhone}`)
    return { skipped: true }
  }

  // Format phone number — add +91 if not present
  let phone = toPhone.toString().replace(/\D/g, '')
  if (phone.length === 10) phone = `+91${phone}`
  else if (phone.length === 12 && phone.startsWith('91')) phone = `+${phone}`
  else if (!phone.startsWith('+')) phone = `+91${phone}`

  // Get message from template
  const getMessage = TEMPLATES[templateType]
  if (!getMessage) {
    console.error(`Unknown SMS template: ${templateType}`)
    return { error: 'Unknown template' }
  }

  const message = getMessage(
    data.hazardType || data.hazard_type || '',
    data.location   || data.locationName || data.address || 'Unknown location',
    data.reportId   || ''
  )

  try {
    const client = require('twilio')(accountSid, authToken)

    const result = await client.messages.create({
      body: message,
      from: fromNumber,
      to:   phone,
    })

    console.log(`✅ SMS sent to ${phone} — SID: ${result.sid}`)
    return { success: true, sid: result.sid, phone, message }

  } catch (err) {
    console.error(`❌ SMS failed to ${phone}: ${err.message}`)
    return { error: err.message }
  }
}

// ── Send SMS to multiple numbers ────────────────────────────
async function sendSMSBulk(phones, templateType, data = {}) {
  const results = []
  for (const phone of phones) {
    if (!phone) continue
    const result = await sendSMS(phone, templateType, data)
    results.push({ phone, ...result })
    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 200))
  }
  return results
}

module.exports = { sendSMS, sendSMSBulk }