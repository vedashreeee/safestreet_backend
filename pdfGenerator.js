const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const axios = require('axios');

// VERCEL FIX: Use /tmp directory in the cloud, local uploads on your laptop
const isVercel = process.env.VERCEL || process.env.VERCEL_ENV;
const OUTPUT_DIR = isVercel 
  ? '/tmp/complaints' 
  : path.join(__dirname, 'uploads', 'complaints');

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
// ── Colour palette ────────────────────────────────────────────────
const C = {
  navy:       '#0F172A',
  navyLight:  '#1E293B',
  gold:       '#B48A3A',
  goldLight:  '#D4A017',
  green:      '#166534',
  amber:      '#9A4213', // Deep amber to match "ACTION REQUESTED:" text
  amberPale:  '#FDF5D3', // Soft yellow to match the action box background
  slate:      '#334155',
  muted:      '#64748B',
  border:     '#E2E8F0',
  pageBg:     '#FFFFFF',
  rowA:       '#F8FAFC',
  hazardBg:   '#FDF8ED',
  white:      '#FFFFFF'
};

const HAZARD_NAMES = {
  pothole:      'Pothole (Road Surface Damage)',
  speedbreaker: 'Damaged / Missing Speed Breaker',
  blindcurve:   'Dangerous Blind Curve',
  lighting:     'Inadequate / Broken Street Lighting',
  collapse:     'Road Collapse / Sinkhole',
  drainage:     'Open / Blocked Drainage',
  pipeline:     'Broken Water Pipeline',
  garbage:      'Illegal Garbage Dumping',
  tree:         'Fallen Tree Blocking Road',
  manhole:      'Uncovered / Damaged Manhole',
};
// ── Reverse geocode ───────────────────────────────────────────────
async function getReadableLocation(lat, lng) {
  try {
    const res  = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`,
      { headers: { 'User-Agent': 'SafeStreet/1.0', 'Accept-Language': 'en' } }
    )
    const data = await res.json()
    const addr = data.address || {}
    const parts = [
      addr.road || addr.pedestrian || addr.neighbourhood,
      addr.suburb || addr.village || addr.city_district,
      addr.county || addr.state_district,
      'Andhra Pradesh',
      addr.postcode,
      'India',
    ].filter(Boolean)
    return parts.join(', ') || data.display_name || `${lat}, ${lng}`
  } catch {
    return `${lat}, ${lng}`
  }
}
// ── Resolve paths ─────────────────────────────────────────────────
// ── Resolve paths ─────────────────────────────────────────────────
function resolveImagePath(r) {
  const raw = r.photo_url || r.image || r.image_url || r.photo || r.photo_path;
  if (!raw) return null;
  
  // If it is a Cloudinary URL, return it immediately
  if (raw.startsWith('http')) return raw;

  // Fallback for local files (development mode)
  const clean = raw.replace(/^\/+/, '');
  const full = path.join(__dirname, clean);
  if (fs.existsSync(full)) return full;
  const alt = path.join(__dirname, 'uploads', clean);
  if (fs.existsSync(alt)) return alt;
  return null;
}
// ── Helper Shapes & Vectors ───────────────────────────────────────
function filledRect(doc, x, y, w, h, r, fill, stroke) {
  doc.roundedRect(x, y, w, h, r);
  if (stroke) doc.fillAndStroke(fill, stroke);
  else        doc.fill(fill);
}

function drawVectorSafeStreet(doc, x, y) {
  const size = 48, cx = x + size/2, s = size/48;
  doc.save();
  doc.lineWidth(2.5 * s).strokeColor(C.navy);
  doc.polygon([cx, y+2*s], [cx+22*s, y+12*s], [cx+22*s, y+36*s], [cx, y+46*s], [cx-22*s, y+36*s], [cx-22*s, y+12*s]).fillAndStroke(C.white, C.navy);
  doc.polygon([cx-8*s, y+38*s], [cx+8*s, y+38*s], [cx+2*s, y+20*s], [cx-2*s, y+20*s]).fill(C.navy);
  doc.moveTo(cx, y+24*s).lineTo(cx, y+34*s).lineWidth(1*s).strokeColor(C.white).stroke();
  doc.circle(cx, y+14*s, 3.5*s).fill(C.gold);
  doc.restore();
}

function drawVectorMunicipality(doc, bx, by) {
  doc.save();
  doc.rect(bx, by, 40, 40).fill('#F8FAFC').stroke(C.gold).lineWidth(1);
  doc.polygon([bx+20, by+6], [bx+34, by+18], [bx+6, by+18]).fill(C.gold);
  doc.rect(bx+10, by+18, 5, 16).fill(C.gold);
  doc.rect(bx+17.5, by+18, 5, 16).fill(C.gold);
  doc.rect(bx+25, by+18, 5, 16).fill(C.gold);
  doc.restore();
}

function drawFooterShield(doc, x, y) {
  doc.save();
  doc.lineJoin('round');
  doc.lineCap('round');
  
  // Thick navy shield outline
  doc.lineWidth(2.2).strokeColor(C.navy);
  doc.moveTo(x, y + 2);
  doc.lineTo(x + 8, y);
  doc.lineTo(x + 16, y + 2);
  doc.lineTo(x + 16, y + 10);
  doc.quadraticCurveTo(x + 16, y + 18, x + 8, y + 22);
  doc.quadraticCurveTo(x, y + 18, x, y + 10);
  doc.closePath();
  doc.stroke();

  // Thick navy checkmark inside
  doc.lineWidth(2);
  doc.moveTo(x + 4, y + 10);
  doc.lineTo(x + 7, y + 13);
  doc.lineTo(x + 12, y + 6);
  doc.stroke();
  
  doc.restore();
}

// ── Main generator ────────────────────────────────────────────────
async function generateComplaintPDF({
  clusterId, centerLat, centerLng, hazardType, reportCount, reports, severity, readableLocation
}) {
  // ADD THIS: Fetch the location if it is missing
  let finalLocation = readableLocation;
  if (!finalLocation) {
      finalLocation = await getReadableLocation(centerLat, centerLng);
  }

  const complaintId = `CMP_${Date.now()}`;
  const filename = `complaint_${complaintId}.pdf`;
  const filePath = path.join(OUTPUT_DIR, filename);
  const relPath = `/uploads/complaints/${filename}`;

  const mapsLink = `https://www.google.com/maps?q=${centerLat},${centerLng}`;
  const hazardName = (typeof hazardType === 'string' && hazardType.includes(',')) 
                     ? hazardType 
                     : (HAZARD_NAMES[hazardType] || hazardType);
                     
  const dateStr = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const isCritical = severity === 'critical';

  const doc = new PDFDocument({ 
      size: 'A4', 
      margins: { top: 35, bottom: 10, left: 40, right: 40 }, 
      bufferPages: true 
  });
  
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);

  // Background
  doc.rect(0, 0, 595, 842).fill(C.pageBg);

  // ── 1. HEADER ──
  const safeStreetLogoPath = path.join(__dirname, 'safestreet_logo.jpg');
  const apGovLogoPath = path.join(__dirname, 'ap_gov_logo.jpg');

  if (fs.existsSync(safeStreetLogoPath)) {
      doc.image(safeStreetLogoPath, 40, 15, { width: 50 });
  } else {
      drawVectorSafeStreet(doc, 40, 15);
  }

  doc.fillColor(C.navy).font('Helvetica-Bold').fontSize(18).text('SAFESTREET', 100, 25);
  doc.fillColor(C.muted).font('Helvetica').fontSize(9).text('Building Safer Roads. Strengthening Communities.', 100, 45);

  if (fs.existsSync(apGovLogoPath)) {
      doc.image(apGovLogoPath, 370, 15, { width: 40 });
  } else {
      drawVectorMunicipality(doc, 370, 15);
  }

  doc.fillColor(C.navy).font('Helvetica-Bold').fontSize(10);
  doc.text('TADIGADAPA MUNICIPALITY', 420, 18, { width: 135 }); 
  
  doc.fillColor(C.slate).font('Helvetica').fontSize(8);
  doc.text('Municipal Administration', 420, doc.y + 2);
  doc.text('Andhra Pradesh', 420, doc.y + 1);

  doc.moveTo(40, 75).lineTo(555, 75).lineWidth(1.5).strokeColor(C.goldLight).stroke();

  // ── 2. TITLE ──
  doc.fillColor(C.navy).font('Helvetica-Bold').fontSize(16).text('OFFICIAL COMPLAINT LETTER', 40, 95, { align: 'center', width: 515 });
  doc.fillColor(C.slate).font('Helvetica').fontSize(10).text('Verified Road Hazard Requiring Immediate Repair Under Municipal Funds', 40, 115, { align: 'center', width: 515 });

  // ── 3. META BAR ──
  const metaY = 145;
  filledRect(doc, 40, metaY, 155, 36, 6, C.rowA, C.border);
  doc.fillColor(C.navy).font('Helvetica-Bold').fontSize(8).text('DATE', 55, metaY + 8);
  doc.fillColor(C.slate).font('Helvetica').fontSize(10).text(dateStr, 55, metaY + 20);

  filledRect(doc, 205, metaY, 175, 36, 6, C.rowA, C.border);
  doc.fillColor(C.green).font('Helvetica-Bold').fontSize(8).text('STATUS', 220, metaY + 8);
  doc.fillColor(C.green).font('Helvetica-Bold').fontSize(10).text(isCritical ? 'CRITICAL' : 'VERIFIED', 220, metaY + 20);
  doc.fillColor(C.muted).font('Helvetica').fontSize(7).text(`— ${reportCount} Independent Reports`, 275, metaY + 22);

  filledRect(doc, 390, metaY, 165, 36, 6, C.rowA, C.border);
  doc.fillColor(C.navy).font('Helvetica-Bold').fontSize(8).text('REFERENCE ID', 405, metaY + 8);
  doc.fillColor(C.slate).font('Helvetica').fontSize(10).text(`SS-ZONE-${clusterId}`, 405, metaY + 20);

  // ── 4. TO & SUBJECT ──
  doc.fillColor(C.navy).font('Helvetica-Bold').fontSize(10).text('TO,', 40, 200);
  doc.fillColor(C.slate).font('Helvetica').fontSize(10).text('Tadigadapa Municipality\nAndhra Pradesh', 40, 213, { lineGap: 2 });

  doc.fillColor(C.navy).font('Helvetica-Bold').fontSize(10).text('SUBJECT:', 40, 245);
  doc.fillColor(C.slate).font('Helvetica').text(' Formal Complaint — Verified Road Hazard Requiring Immediate Repair', 95, 245);
  doc.moveTo(40, 260).lineTo(555, 260).lineWidth(0.5).strokeColor(C.border).stroke();

  // ── 5. INTRODUCTION TEXT ──
  doc.fillColor(C.slate).font('Helvetica').fontSize(9)
     .text(`This is to bring to your urgent attention a verified road hazard that has been independently reported by ${reportCount} citizens through the SafeStreet community reporting platform.`, 40, 270, { width: 515, lineGap: 2 })
     .text(`The SafeStreet clustering system has confirmed this as a Verified Danger Zone based on multiple independent reports within a 50-metre radius over the past 30 days.`, 40, 295, { width: 515, lineGap: 2 });

  // ── 6. DYNAMIC HAZARD DETAILS CARD ──
  let docY = 325; 
  doc.fontSize(9);
  
  const w340 = { width: 340 };
  const coordText = `${centerLat.toFixed(6)}, ${centerLng.toFixed(6)}`;
  const reportText = `${reportCount} Independent Citizen Reports`;
  
  const h1 = doc.heightOfString(hazardName, w340);
  const h2 = doc.heightOfString(finalLocation || 'Location unavailable', w340);
  const h3 = doc.heightOfString(coordText, w340);
  const h4 = doc.heightOfString(reportText, w340);
  
  const totalDetailsHeight = 35 + h1 + 6 + h2 + 6 + h3 + 6 + h4 + 15;
  
  filledRect(doc, 40, docY, 515, totalDetailsHeight, 8, C.hazardBg, C.goldLight);
  
  doc.polygon([60, docY+28], [70, docY+12], [80, docY+28]).fill(C.amber);
  doc.fillColor(C.white).font('Helvetica-Bold').fontSize(10).text('!', 68, docY+15);
  doc.fillColor(C.navy).font('Helvetica-Bold').fontSize(11).text('HAZARD DETAILS', 90, docY + 16);

  let rowY = docY + 38;
  const printRow = (label, value, isLink = false) => {
    doc.circle(50, rowY + 4, 2).fill(C.slate);
    doc.fillColor(C.slate).font('Helvetica').fontSize(9).text(label, 60, rowY);
    doc.text(':', 140, rowY);
    
    if (isLink) {
      doc.fillColor('#1D4ED8').font('Helvetica-Bold').text(value, 155, rowY, Object.assign({}, w340, { link: mapsLink, underline: true }));
    } else {
      doc.fillColor(C.slate).font('Helvetica-Bold').text(value, 155, rowY, w340);
    }
    rowY += doc.heightOfString(value, w340) + 6;
  };
  
  printRow('Hazard Type', hazardName);
  printRow('Location', finalLocation || 'Location unavailable');
  printRow('GPS Coordinates', coordText, true);
  printRow('Report Count', reportText);

  docY += totalDetailsHeight + 15;

  // ── 7. REPORT RECORDS TABLE ──
  doc.fillColor(C.navy).font('Helvetica-Bold').fontSize(10).text('REPORT RECORDS', 40, docY + 2);
  filledRect(doc, 40, docY + 15, 515, 18, 0, C.navy);
  doc.fillColor(C.white).font('Helvetica-Bold').fontSize(8)
     .text('#', 50, docY + 20)
     .text('REPORT ID', 90, docY + 20)
     .text('DATE', 210, docY + 20)
     .text('HAZARD TYPE', 320, docY + 20)
     .text('TIME', 450, docY + 20);

  const maxRows = Math.min(reports.length, 5);
  for (let i = 0; i < maxRows; i++) {
    const r = reports[i];
    const rY = docY + 33 + (i * 18);
    doc.rect(40, rY, 515, 18).fill(i % 2 === 0 ? C.rowA : C.white);
    
    const d = new Date(r.created_at || Date.now());
    doc.fillColor(C.slate).font('Helvetica').fontSize(8)
       .text(String(i + 1), 50, rY + 5)
       .text(r.report_id || r.id || '-', 90, rY + 5)
       .text(d.toLocaleDateString('en-IN'), 210, rY + 5)
       .text(r.hazard_type || hazardType, 320, rY + 5)
       .text(d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }), 450, rY + 5);
  }
  doc.rect(40, docY + 15, 515, 18 + (maxRows * 18)).stroke(C.border);
  
  docY += 15 + (maxRows * 18) + 15;

  // ── 8. ACTION REQUESTED (Updated to match screenshot exactly) ──
  filledRect(doc, 40, docY, 515, 60, 6, C.amberPale, C.border);
  
  doc.fillColor(C.amber).font('Helvetica-Bold').fontSize(12).text('ACTION REQUESTED:', 55, docY + 12);
  
  doc.fillColor(C.slate).font('Helvetica').fontSize(9)
     .text('1. Immediate on-site inspection of the reported location', 55, docY + 30)
     .text('2. Allocation of repair funds under municipal budget', 55, docY + 44)
     .text('3. Completion of repair work within 30 days', 315, docY + 30)
     .text('4. Notification to all reporters upon resolution', 315, docY + 44);

  docY += 75;

  // ── 9. PHOTO EVIDENCE THUMBNAILS ──
  const photoReports = reports.filter(r => resolveImagePath(r));

  if (photoReports.length > 0) {
    doc.fillColor(C.navy).font('Helvetica-Bold').fontSize(10).text('PHOTO EVIDENCE', 40, docY + 4);
    doc.moveTo(140, docY + 9).lineTo(555, docY + 9).lineWidth(1).strokeColor(C.navy).stroke();

    const maxPhotos = Math.min(photoReports.length, 5);
    const thumbW = 95, thumbH = 65, gap = 10;
    
    for (let i = 0; i < maxPhotos; i++) {
      const r = photoReports[i];
      const imgSource = resolveImagePath(r);
      const px = 40 + i * (thumbW + gap);
      const thumbY = docY + 18;

      filledRect(doc, px, thumbY, thumbW, thumbH, 2, C.rowA, C.border);
      
      try {
        if (imgSource.startsWith('http')) {
          // 1. Download image from Cloudinary into memory
          const imgRes = await axios.get(imgSource, { responseType: 'arraybuffer' });
          const imgBuffer = Buffer.from(imgRes.data, 'utf-8');
          // 2. Pass the memory buffer to PDFKit
          doc.image(imgBuffer, px, thumbY, { fit: [thumbW, thumbH - 12], align: 'center', valign: 'center' });
        } else {
          // Local file fallback
          doc.image(imgSource, px, thumbY, { fit: [thumbW, thumbH - 12], align: 'center', valign: 'center' });
        }
      } catch (e) {
        console.error("PDF Image Error:", e.message);
        doc.fillColor(C.muted).font('Helvetica').fontSize(7)
           .text('Image Error', px, thumbY + 20, { width: thumbW, align: 'center' });
      }

      filledRect(doc, px, thumbY + thumbH - 12, thumbW, 12, 0, C.navy);
      doc.fillColor(C.white).font('Helvetica-Bold').fontSize(6)
         .text(`Report ID: ${r.report_id || r.id || '-'}`, px + 3, thumbY + thumbH - 9);
    }
  }

  // ── 10. SCREENSHOT-ACCURATE FOOTER WITH SHIELD ICON ──
  const fY = 785; 
  filledRect(doc, 40, fY, 515, 45, 6, C.rowA, C.border);
  
  // Draw the new accurate shield/checkmark icon
  drawFooterShield(doc, 60, fY + 11);
  
  doc.fillColor(C.slate).font('Helvetica').fontSize(9)
     .text('This complaint letter has been auto-generated by SafeStreet.', 95, fY + 15, { lineBreak: false })
     .text('All reports are crowd-sourced and verified through spatial clustering.', 95, fY + 27, { lineBreak: false });

  doc.end();

  return new Promise((resolve, reject) => {
    stream.on('finish', async () => {
  // Try to upload to Cloudinary if configured
  if (
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
  ) {
    try {
      const cloudinary = require('./cloudinary')
      const result = await cloudinary.uploader.upload(filePath, {
        folder:        'safestreet/complaints',
        resource_type: 'raw',
        public_id:     complaintId,
        format:        'pdf',
      })
      // Delete local file after successful upload
      fs.unlink(filePath, () => {})
      console.log(`☁️  PDF uploaded to Cloudinary: ${result.secure_url}`)
      resolve({
        complaintId,
        relPath:      result.secure_url,  // Full https:// URL
        filename,
        locationName: readableLocation,
        address:      readableLocation,
      })
    } catch (uploadErr) {
      console.warn('Cloudinary PDF upload failed, using local path:', uploadErr.message)
      resolve({
        complaintId,
        relPath: `/uploads/complaints/${filename}`,
        filename,
        locationName: readableLocation,
        address:      readableLocation,
      })
    }
  } else {
    // No Cloudinary — use local path
    resolve({
      complaintId,
      relPath: `/uploads/complaints/${filename}`,
      filename,
      locationName: readableLocation,
      address:      readableLocation,
    })
  }
})
stream.on('error', reject)
  });
}

module.exports = { generateComplaintPDF };