const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");
const bwipjs = require("bwip-js");

const app = express();
const PORT = process.env.PORT || 3000;

app.use('/pdfs', express.static(path.join(__dirname, 'eCOC IC Labs')));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// ---------------- DATABASE ----------------

const db = new sqlite3.Database("./ecoc.db");

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      protocol_name TEXT,
      site_name TEXT,
      shipping_date TEXT,
      shipped_by TEXT,
      courier_name TEXT,
      page_numbers TEXT,
      requisition_number TEXT,
      pid TEXT,
      sample_type TEXT,
      shipping_temp REAL,
      delivery_temp REAL,
      temp_type TEXT,
      sample_count_collected INTEGER,
      sample_count_delivered INTEGER,
      discrepancy_reason TEXT,
      visit_number TEXT,
      collection_datetime TEXT,
      receiver TEXT,
      receiving_datetime TEXT,
      sample_status TEXT
    )
  `);
});

// ---------------- HELPERS ----------------

function todayDate(){
  return new Date().toISOString().split("T")[0];
}

function formatDateTime(dt){
  return dt ? dt.replace("T"," ") : "";
}

// ---------------- FORM ----------------

function renderForm(role) {
  // Fields editable per role
  const siteFields = ['protocol_name','site_name','shipping_date','requisition_number','pid','sample_type'];
  const driverFields = ['temp_type','courier_name','shipping_temp','delivery_temp','collection_datetime'];
  const labFields = ['receiver','receiving_datetime','sample_status'];

  function isDisabled(fieldName){
    if(role === 'site') return !siteFields.includes(fieldName) ? 'disabled' : '';
    if(role === 'driver') return !driverFields.includes(fieldName) ? 'disabled' : '';
    if(role === 'lab') return !labFields.includes(fieldName) ? 'disabled' : '';
    return '';
  }

  return `
  <html>
  <head>
    <title>IC Labs eCOC</title>
    <style>
    /* Keep all your existing CSS */
    .time-invalid{background-color:#fdeaea;border:2px solid #e74c3c;}
    .temp-valid{background-color:#e8f8e8;border:2px solid #2ecc71;}
    .temp-invalid{background-color:#fdeaea;border:2px solid #e74c3c;}
    body{font-family:Arial;padding:30px;background:#f4f6f9;}
    form{max-width:700px;margin:auto;background:white;padding:30px;border-radius:10px;box-shadow:0 4px 10px rgba(0,0,0,0.1);}
    label{font-weight:bold;margin-top:15px;display:block;}
    input,select{width:100%;padding:8px;margin-top:5px;border-radius:5px;border:1px solid #ccc;}
    button{margin-top:20px;padding:10px;width:100%;background:#2c3e50;color:white;border:none;border-radius:5px;cursor:pointer;}
    .hidden{display:none;}
    </style>
  </head>
  <body>
    <div style="text-align:center;margin-bottom:25px;">
      <img src="/IC_Labs_Logo.png" style="width:180px;">
      <p style="margin-top:5px;font-size:14px;color:#555;">Electronic Chain of Custody</p>
    </div>

    <form method="POST" action="/add">
      <label>Protocol Name</label>
      <select name="protocol_name" onchange="toggleOther(this,'protocolOther')" ${isDisabled('protocol_name')}>
        <option>Brilliant011</option><option>Transgender</option><option>Align</option><option>Other</option>
      </select>
      <input id="protocolOther" name="protocolOther" class="hidden" placeholder="Enter Protocol" ${isDisabled('protocol_name')}>

      <label>Site Name</label>
      <select name="site_name" onchange="toggleOther(this,'siteOther')" ${isDisabled('site_name')}>
        <option>GSH J52</option><option>Philippi Village</option><option>Other</option>
      </select>
      <input id="siteOther" name="siteOther" class="hidden" placeholder="Enter Site" ${isDisabled('site_name')}>

      <label>Shipping Date</label>
      <input type="date" name="shipping_date" value="${todayDate()}" ${isDisabled('shipping_date')}>

      <label>Requisition Number</label>
      <input name="requisition_number" ${isDisabled('requisition_number')}>

      <label>PID</label>
      <input name="pid" ${isDisabled('pid')}>

      <label>Sample Type</label>
      <select name="sample_type" onchange="toggleOther(this,'sampleOther')" ${isDisabled('sample_type')}>
        <option>Blood</option><option>Leukopak</option><option>Sputum</option><option>Urine</option><option>Other</option>
      </select>
      <input id="sampleOther" name="sampleOther" class="hidden" placeholder="Enter Sample Type" ${isDisabled('sample_type')}>

      <label>Temperature Type</label>
      <select name="temp_type" onchange="toggleOther(this,'tempOther');checkTemp();" ${isDisabled('temp_type')}>
        <option>Ambient</option><option>Refrigerated</option><option>Other</option>
      </select>
      <input id="tempOther" name="tempOther" class="hidden" type="text" placeholder="Enter Temperature Type" ${isDisabled('temp_type')}>

      <label>Shipping Temperature</label>
      <input type="number" step="0.1" name="shipping_temp" id="shipTemp" oninput="checkTemp()" ${isDisabled('shipping_temp')}>
      <div id="shipTempMsg" style="font-size:13px;margin-top:3px;"></div>

      <label>Delivery Temperature</label>
      <input type="number" step="0.1" name="delivery_temp" id="delTemp" oninput="checkTemp()" ${isDisabled('delivery_temp')}>
      <div id="delTempMsg" style="font-size:13px;margin-top:3px;"></div>

      <label>Collection Date & Time</label>
      <input type="datetime-local" id="collectionTime" name="collection_datetime" oninput="checkTransitTime()" ${isDisabled('collection_datetime')}>

      <label>Receiver</label>
      <select name="receiver" onchange="toggleOther(this,'receiverOther')" ${isDisabled('receiver')}>
        <option>Natasha.G</option><option>Drew.M</option><option>Lameez.P</option><option>Nthabiseng</option><option>Viola</option><option>Other</option>
      </select>
      <input id="receiverOther" name="receiverOther" class="hidden" type="text" placeholder="Enter Receiver Name" ${isDisabled('receiver')}>

      <label>Receiving Date & Time</label>
      <input type="datetime-local" id="receivingTime" name="receiving_datetime" oninput="checkTransitTime()" ${isDisabled('receiving_datetime')}>

      <label>Sample Status</label>
      <select name="sample_status" ${isDisabled('sample_status')}>
        <option value="">-- None Selected --</option><option>Testing</option><option>Storage</option><option>Disposed</option>
      </select>

      <button type="submit">Generate eCOC</button>
    </form>

    <script>
      // Keep all your existing JS functions (toggleOther, checkTemp, checkTransitTime, etc.)
    </script>
  </body>
  </html>
  `;
}

// ---------------- ROUTES ----------------

// ---------------- LOGIN ----------------
const rolePasswords = {
  site: "site123",
  driver: "driver123",
  lab: "lab123"
};

app.get("/login", (req, res) => {
  res.send(`
    <html>
      <head>
        <title>eCOC Login</title>
        <style>
          body { font-family: Arial; padding: 50px; background: #f4f6f9; text-align: center; }
          input, select, button { padding: 10px; margin: 10px; width: 200px; }
          button { background: #2c3e50; color: white; border: none; border-radius: 5px; cursor: pointer; }
        </style>
      </head>
      <body>
        <h2>eCOC Access</h2>
        <form method="POST" action="/login">
          <label>Role:</label><br>
          <select name="role">
            <option value="site">Site</option>
            <option value="driver">Driver</option>
            <option value="lab">Lab</option>
          </select><br>
          <label>Password:</label><br>
          <input type="password" name="password"><br>
          <button type="submit">Enter</button>
        </form>
      </body>
    </html>
  `);
});

app.post("/login", (req, res) => {
  const { role, password } = req.body;

  if(rolePasswords[role] && password === rolePasswords[role]) {
    res.redirect(`/form?role=${role}`);
  } else {
    res.send("<h3>Invalid role or password. <a href='/login'>Try again</a></h3>");
  }
});

app.get("/form", (req, res) => {
  const role = req.query.role;
  if(!role || !["site","driver","lab"].includes(role)){
    return res.redirect("/login");
  }
  res.send(renderForm(role));
});

app.get("/new", (req, res) => {
  const role = req.query.role || "site";
  res.send(renderForm(role));
});

app.get("/coc/:id", (req, res) => {
  const id = req.params.id;
  const role = req.query.role || "site";

  db.get("SELECT * FROM samples WHERE id = ?", [id], (err, row) => {
    if (err || !row) return res.send("COC not found");

    res.send(renderEditForm(row, role));
  });
});

app.get("/view-pdfs", (req, res) => {
  const pdfDir = path.join(__dirname, "eCOC IC Labs");

  fs.readdir(pdfDir, (err, files) => {
    if (err) return res.send("Error reading PDF folder.");

    const pdfFiles = files.filter(f => f.endsWith(".pdf"));

    let html = "<h2>All eCOC PDFs</h2><ul>";
    pdfFiles.forEach(file => {
      html += `<li><a href="/pdfs/${file}" target="_blank">${file}</a></li>`;
    });
    html += "</ul>";

    res.send(html);
  });
});

// ---------------- ADD ----------------
app.post("/add", async (req,res)=>{
  const d=req.body;

  const protocol=d.protocol_name==="Other"?d.protocolOther:d.protocol_name;
  const site=d.site_name==="Other"?d.siteOther:d.site_name;
  const shipper=d.shipped_by==="Other"?d.shipOther:d.shipped_by;
  const courier=d.courier_name==="Other"?d.courierOther:d.courier_name;
  const sampleType=d.sample_type==="Other"?d.sampleOther:d.sample_type;
  const receiver=d.receiver==="Other"?d.receiverOther:d.receiver;
  const tempType=d.temp_type==="Other"?d.tempOther:d.temp_type;

  db.run(`
    INSERT INTO samples (
      protocol_name,site_name,shipping_date,shipped_by,courier_name,
      page_numbers,requisition_number,pid,sample_type,
      shipping_temp,delivery_temp,temp_type,
      sample_count_collected,sample_count_delivered,discrepancy_reason,
      visit_number,collection_datetime,receiver,receiving_datetime,sample_status
    )
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `,
  [
    protocol,site,d.shipping_date,shipper,courier,
    d.page_numbers,d.requisition_number,d.pid,sampleType,
    d.shipping_temp,d.delivery_temp,tempType,
    d.sample_count_collected,d.sample_count_delivered,d.discrepancy_reason,
    d.visit_number,d.collection_datetime,d.receiver,d.receiving_datetime,d.sample_status
  ],
  async function(err){
    if(err) return res.send("DB Error: "+err.message);

    // PDF creation logic (unchanged)
    // ...
    res.redirect("/");
  });
});

// ---------------- UPDATE ----------------
app.post("/update/:id", (req, res) => {
  const id = req.params.id;
  const d = req.body;

  db.run(`
    UPDATE samples SET
      protocol_name=?, site_name=?, shipping_date=?, requisition_number=?,
      pid=?, sample_type=?, courier_name=?, temp_type=?,
      shipping_temp=?, delivery_temp=?, collection_datetime=?,
      receiver=?, receiving_datetime=?, sample_status=?
    WHERE id=?
  `,
  [
    d.protocol_name,d.site_name,d.shipping_date,d.requisition_number,
    d.pid,d.sample_type,d.courier_name,d.temp_type,
    d.shipping_temp,d.delivery_temp,d.collection_datetime,
    d.receiver,d.receiving_datetime,d.sample_status,id
  ],
  (err) => {
    if (err) return res.send("Update error");

    res.redirect(`/coc/${id}?role=${req.query.role}`);
  });
});

// ---------------- SERVER ----------------
if (!global.__portDeclared) {
    app.listen(PORT, () => console.log("Server running on port " + PORT));
    global.__portDeclared = true;
}