// server.js
const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const bodyParser = require("body-parser");

const app = express();
const PORT = 3000;

// Middleware
app.use(bodyParser.urlencoded({ extended: true }));

// Database setup
const db = new sqlite3.Database("./ecoc.db");
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      protocol_name TEXT,
      site_name TEXT,
      shipping_date DATE,
      shipped_by TEXT,
      courier_name TEXT,
      collection_datetime DATETIME,
      page_numbers TEXT,
      requisition_number TEXT,
      pid TEXT,
      sample_type TEXT,
      shipping_temp REAL,
      temp_type TEXT,
      tube_count_collected INTEGER,
      tube_count_delivered INTEGER,
      discrepancy_reason TEXT,
      visit_number TEXT,
      ic_initials TEXT,
      ic_date DATE
    )
  `);
});

// Helper to render form
function renderForm(data = {}, errors = {}) {
  // Show discrepancy if counts exist and mismatch
  const showDiscrepancy = data.tube_count_collected != data.tube_count_delivered;

  return `
    <form method="POST" action="/add">
      <label>Protocol Name:</label>
      <input name="protocol_name" value="${data.protocol_name || ''}" class="${errors.protocol_name ? 'input-error' : ''}">
      <div class="field-error">${errors.protocol_name || ''}</div>

      <label>Site Name:</label>
      <input name="site_name" value="${data.site_name || ''}" class="${errors.site_name ? 'input-error' : ''}">
      <div class="field-error">${errors.site_name || ''}</div>

      <label>Shipping Date:</label>
      <input type="date" name="shipping_date" value="${data.shipping_date || ''}" class="${errors.shipping_date ? 'input-error' : ''}">
      <div class="field-error">${errors.shipping_date || ''}</div>

      <label>Shipped By:</label>
      <input name="shipped_by" value="${data.shipped_by || ''}" class="${errors.shipped_by ? 'input-error' : ''}">
      <div class="field-error">${errors.shipped_by || ''}</div>

      <label>Courier Name:</label>
      <input name="courier_name" value="${data.courier_name || ''}" class="${errors.courier_name ? 'input-error' : ''}">
      <div class="field-error">${errors.courier_name || ''}</div>

      <label>Collection Date & Time:</label>
      <input type="datetime-local" name="collection_datetime" value="${data.collection_datetime || ''}" class="${errors.collection_datetime ? 'input-error' : ''}">
      <div class="field-error">${errors.collection_datetime || ''}</div>

      <label>Page Numbers:</label>
      <input name="page_numbers" value="${data.page_numbers || ''}" class="${errors.page_numbers ? 'input-error' : ''}">
      <div class="field-error">${errors.page_numbers || ''}</div>

      <label>Requisition Number:</label>
      <input name="requisition_number" value="${data.requisition_number || ''}" class="${errors.requisition_number ? 'input-error' : ''}">
      <div class="field-error">${errors.requisition_number || ''}</div>

      <label>PID:</label>
      <input name="pid" value="${data.pid || ''}" class="${errors.pid ? 'input-error' : ''}">
      <div class="field-error">${errors.pid || ''}</div>

      <label>Sample Type:</label>
      <input name="sample_type" value="${data.sample_type || ''}" class="${errors.sample_type ? 'input-error' : ''}">
      <div class="field-error">${errors.sample_type || ''}</div>

      <label>Shipping Temp (°C):</label>
      <input type="number" step="0.1" name="shipping_temp" value="${data.shipping_temp || ''}" class="${errors.shipping_temp ? 'input-error' : ''}">
      <div class="field-error">${errors.shipping_temp || ''}</div>

      <label>Temperature Type:</label>
      <select name="temp_type" class="${errors.temp_type ? 'input-error' : ''}">
        <option value="ambient" ${data.temp_type === 'ambient' ? 'selected' : ''}>Ambient</option>
        <option value="refrigerated" ${data.temp_type === 'refrigerated' ? 'selected' : ''}>Refrigerated</option>
      </select>
      <div class="field-error">${errors.temp_type || ''}</div>

      <label>Tubes Collected:</label>
      <input type="number" id="tube_collected" name="tube_count_collected" value="${data.tube_count_collected || ''}" class="${errors.tube_count_collected ? 'input-error' : ''}">
      <div class="field-error">${errors.tube_count_collected || ''}</div>

      <label>Tubes Delivered:</label>
      <input type="number" id="tube_delivered" name="tube_count_delivered" value="${data.tube_count_delivered || ''}" class="${errors.tube_count_delivered ? 'input-error' : ''}">
      <div class="field-error">${errors.tube_count_delivered || ''}</div>

      <div id="discrepancy-block" style="display:${showDiscrepancy ? 'block' : 'none'}">
        <label>Reason for Tube Count Discrepancy:</label>
        <input name="discrepancy_reason" value="${data.discrepancy_reason || ''}" class="${errors.discrepancy_reason ? 'input-error' : ''}" ${showDiscrepancy ? 'required' : ''}>
        <div class="field-error">${errors.discrepancy_reason || ''}</div>
      </div>

      <label>Visit Number:</label>
      <input name="visit_number" value="${data.visit_number || ''}" class="${errors.visit_number ? 'input-error' : ''}">
      <div class="field-error">${errors.visit_number || ''}</div>

      <label>IC Initials:</label>
      <input name="ic_initials" value="${data.ic_initials || ''}" class="${errors.ic_initials ? 'input-error' : ''}">
      <div class="field-error">${errors.ic_initials || ''}</div>

      <label>IC Date:</label>
      <input type="date" name="ic_date" value="${data.ic_date || ''}" class="${errors.ic_date ? 'input-error' : ''}">
      <div class="field-error">${errors.ic_date || ''}</div>

      <button type="submit">Submit</button>
    </form>

    <script>
      const tubeCollected = document.getElementById("tube_collected");
      const tubeDelivered = document.getElementById("tube_delivered");
      const discrepancyBlock = document.getElementById("discrepancy-block");

      function toggleDiscrepancy() {
        if(tubeCollected.value !== tubeDelivered.value) {
          discrepancyBlock.style.display = "block";
          discrepancyBlock.querySelector("input").required = true;
        } else {
          discrepancyBlock.style.display = "none";
          discrepancyBlock.querySelector("input").required = false;
        }
      }

      tubeCollected.addEventListener("input", toggleDiscrepancy);
      tubeDelivered.addEventListener("input", toggleDiscrepancy);
    </script>
  `;
}

// Homepage route
app.get("/", (req, res) => {
  db.all("SELECT * FROM samples ORDER BY id DESC", [], (err, rows) => {
    let tableRows = rows.map(row => `
      <tr>
        <td>${row.protocol_name}</td><td>${row.site_name}</td><td>${row.shipping_date}</td><td>${row.shipped_by}</td>
        <td>${row.courier_name}</td><td>${row.collection_datetime}</td><td>${row.page_numbers}</td>
        <td>${row.requisition_number}</td><td>${row.pid}</td><td>${row.sample_type}</td>
        <td>${row.shipping_temp} °C</td><td>${row.temp_type}</td><td>${row.tube_count_collected}</td>
        <td>${row.tube_count_delivered}</td><td>${row.discrepancy_reason || ''}</td>
        <td>${row.visit_number}</td><td>${row.ic_initials}</td><td>${row.ic_date}</td>
      </tr>
    `).join("");

    res.send(`
      <html>
      <head>
        <title>eCOC Dry Run</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 20px; }
          h1 { color: #2c3e50; }
          form { display: flex; flex-direction: column; gap:12px; max-width:500px; padding:20px; border:1px solid #ccc; border-radius:8px; background:#f9f9f9; }
          label { font-weight:bold; margin-bottom:4px; }
          input, select { padding:6px 10px; border-radius:4px; border:1px solid #ccc; width:100%; box-sizing:border-box; }
          .input-error { border-color:red; }
          .field-error { color:red; font-size:0.9em; margin-top:-8px; margin-bottom:6px; }
          button { width:150px; padding:8px 15px; background-color:#2c3e50; color:white; border:none; border-radius:4px; cursor:pointer; margin-top:10px; }
          button:hover { background-color:#34495e; }
          table { border-collapse: collapse; width: 100%; max-height:400px; overflow-y:auto; display:block; }
          th, td { border:1px solid #ccc; padding:8px; text-align:center; }
          th { background-color:#2c3e50; color:white; position:sticky; top:0; }
          tr:nth-child(even) { background-color:#f2f2f2; }
          h2 { margin-top:40px; }
        </style>
      </head>
      <body>
        <h1>eCOC Dry Run with Tube Discrepancy</h1>
        ${renderForm()}
        <h2>Samples Log</h2>
        <table>
          <tr>
            <th>Protocol</th><th>Site</th><th>Shipping Date</th><th>Shipped By</th><th>Courier</th>
            <th>Collection DateTime</th><th>Page #</th><th>Requisition</th><th>PID</th><th>Sample Type</th>
            <th>Temp (°C)</th><th>Temp Type</th><th>Tubes Collected</th><th>Tubes Delivered</th>
            <th>Discrepancy Reason</th><th>Visit #</th><th>IC Initials</th><th>IC Date</th>
          </tr>
          ${tableRows}
        </table>
      </body>
      </html>
    `);
  });
});

// POST /add route
app.post("/add", (req, res) => {
  const data = req.body;
  let errors = {};

  // Validations
  if (!/^\d{3}$/.test(data.requisition_number)) errors.requisition_number = "Requisition number invalid";
  if (!/^\d{5}$/.test(data.pid)) errors.pid = "PID invalid";

  const temp = parseFloat(data.shipping_temp);
  if (data.temp_type === "ambient") {
    if (temp < 15) errors.shipping_temp = "Temp too low";
    else if (temp > 25) errors.shipping_temp = "Temp too high";
  } else if (data.temp_type === "refrigerated") {
    if (temp < 2) errors.shipping_temp = "Temp too low";
    else if (temp > 8) errors.shipping_temp = "Temp too high";
  }

  if (parseInt(data.tube_count_collected) !== parseInt(data.tube_count_delivered)) {
    if (!data.discrepancy_reason || data.discrepancy_reason.trim() === '') {
      errors.discrepancy_reason = "Reason required for tube count discrepancy";
    }
  }

  if (Object.keys(errors).length > 0) {
    db.all("SELECT * FROM samples ORDER BY id DESC", [], (err, rows) => {
      res.send(renderPageWithErrors(data, errors, rows));
    });
  } else {
    const stmt = `
      INSERT INTO samples
      (protocol_name, site_name, shipping_date, shipped_by, courier_name, collection_datetime,
       page_numbers, requisition_number, pid, sample_type, shipping_temp, temp_type,
       tube_count_collected, tube_count_delivered, discrepancy_reason, visit_number, ic_initials, ic_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    db.run(stmt, [
      data.protocol_name, data.site_name, data.shipping_date, data.shipped_by, data.courier_name,
      data.collection_datetime, data.page_numbers, data.requisition_number, data.pid, data.sample_type,
      data.shipping_temp, data.temp_type, data.tube_count_collected, data.tube_count_delivered,
      data.discrepancy_reason || null, data.visit_number, data.ic_initials, data.ic_date
    ], () => res.redirect("/"));
  }
});

app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));