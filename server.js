const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");
const bwipjs = require("bwip-js");


const app = express();
app.use('/pdfs', express.static(path.join(__dirname, 'eCOC IC Labs')));
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// ---------------- ROLE-BASED LOGIN ----------------

// Define users and passwords
const users = {
    site: "site123",
    driver: "driver123",
    lab: "lab123"
};

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

db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_reqnum ON samples(requisition_number)");

// ---------------- HELPERS ----------------

function todayDate(){
return new Date().toISOString().split("T")[0];
}

function formatDateTime(dt){
return dt ? dt.replace("T"," ") : "";
}

// ---------------- FORM ----------------

function renderForm(role, data = {}){
const isSite = role === "site";
const isDriver = role === "driver";
const isLab = role === "lab";

return `
<html>
<head>

<title>IC Labs eCOC</title>

<style>
.time-invalid{
background-color:#fdeaea;
border:2px solid #e74c3c;
}
temp-valid{
background-color:#e8f8e8;
border:2px solid #2ecc71;
}

temp-invalid{
background-color:#fdeaea;
border:2px solid #e74c3c;
}
body{
font-family:Arial;
padding:30px;
background:#f4f6f9;

}

form{
max-width:700px;
margin:auto;
background:white;
padding:30px;
border-radius:10px;
box-shadow:0 4px 10px rgba(0,0,0,0.1);
}

label{
font-weight:bold;
margin-top:15px;
display:block;
}

input,select{
width:100%;
padding:8px;
margin-top:5px;
border-radius:5px;
border:1px solid #ccc;
}

button{
margin-top:20px;
padding:10px;
width:100%;
background:#2c3e50;
color:white;
border:none;
border-radius:5px;
cursor:pointer;
}

.hidden{
display:none;
}

</style>

</head>

<body>

<div style="text-align:center;margin-bottom:25px;">
<img src="/IC_Labs_Logo.png" style="width:180px;">
<p style="margin-top:5px;font-size:14px;color:#555;">
Electronic Chain of Custody
</p>
</div>

<form method="POST" action="/add">
<input type="hidden" name="id" value="${data.id || ''}">
<input type="hidden" name="role" value="${role}">

<label>Protocol Name</label>
<select name="protocol_name" onchange="toggleOther(this,'protocolOther')" ${isDriver ? "disabled" : ""}${isLab ? "disabled" : ""}>
  <option ${data.protocol_name==='Brilliant011'?'selected':''}>Brilliant011</option>
  <option ${data.protocol_name==='Transgender'?'selected':''}>Transgender</option>
  <option ${data.protocol_name==='Align'?'selected':''}>Align</option>
  <option ${data.protocol_name==='Other'?'selected':''}>Other</option>
</select>
<input id="protocolOther" name="protocolOther" class="hidden" placeholder="Enter Protocol" value="${data.protocol_name==='Other'?data.protocolOther:''}">

<label>Site Name</label>
<select name="site_name" onchange="toggleOther(this,'siteOther')" ${isDriver ? "disabled" : ""}${isLab ? "disabled" : ""}>
  <option ${data.site_name==='GSH J52'?'selected':''}>GSH J52</option>
  <option ${data.site_name==='Philippi Village'?'selected':''}>Philippi Village</option>
  <option ${data.site_name==='Other'?'selected':''}>Other</option>
</select>
<input id="siteOther" name="siteOther" class="hidden" placeholder="Enter Site" value="${data.site_name==='Other'?data.siteOther:''}">
<label>Shipping Date</label>
<input type="date" name="shipping_date" value="${data.shipping_date || todayDate()}">

<label>Shipped By</label>
<select name="shipped_by" onchange="toggleOther(this,'shipOther')" ${isDriver ? "disabled" : ""}${isLab ? "disabled" : ""}>
  <option ${data.shipped_by==='Dorothy'?'selected':''}>Dorothy</option>
  <option ${data.shipped_by==='Anele'?'selected':''}>Anele</option>
  <option ${data.shipped_by==='Other'?'selected':''}>Other</option>
</select>
<input id="shipOther" name="shipOther" class="hidden" placeholder="Enter Name" value="${data.shipped_by==='Other'?data.shipOther:''}">

<label>Courier Name</label>
<select name="courier_name" onchange="toggleOther(this,'courierOther')" ${isSite ? "disabled" : ""}${isLab ? "disabled" : ""}>
  <option ${data.courier_name==='Rodon Global'?'selected':''}>Rodon Global</option>
  <option ${data.courier_name==='Other'?'selected':''}>Other</option>
</select>
<input id="courierOther" name="courierOther" class="hidden" placeholder="Enter Courier" value="${data.courier_name==='Other'?data.courierOther:''}">

<label>Page Numbers</label>
<input name="page_numbers" value="${data.page_numbers || ''}"${isDriver ? "disabled" : ""}${isLab ? "disabled" : ""}>

<label>Requisition Number</label>
<input name="requisition_number" value="${data.requisition_number || ''}"${isDriver ? "disabled" : ""}${isLab ? "disabled" : ""}>

<label>PID</label>
<input name="pid" value="${data.pid || ''}"${isDriver ? "disabled" : ""}${isLab ? "disabled" : ""}>

<label>Sample Type</label>
<select name="sample_type" onchange="toggleOther(this,'sampleOther')" ${isDriver ? "disabled" : ""}${isLab ? "disabled" : ""}>
  <option ${data.sample_type==='Blood'?'selected':''}>Blood</option>
  <option ${data.sample_type==='Leukopak'?'selected':''}>Leukopak</option>
  <option ${data.sample_type==='Sputum'?'selected':''}>Sputum</option>
  <option ${data.sample_type==='Urine'?'selected':''}>Urine</option>
  <option ${data.sample_type==='Other'?'selected':''}>Other</option>
</select>
<input id="sampleOther" name="sampleOther" class="hidden" placeholder="Enter Sample Type" value="${data.sample_type==='Other'?data.sampleOther:''}">


<label>Temperature Type</label>
<select name="temp_type" onchange="toggleOther(this,'tempOther');checkTemp();" ${isSite ? "disabled" : ""}${isLab ? "disabled" : ""}>
  <option ${data.temp_type==='Ambient'?'selected':''}>Ambient</option>
  <option ${data.temp_type==='Refrigerated'?'selected':''}>Refrigerated</option>
  <option ${data.temp_type==='Other'?'selected':''}>Other</option>
</select>
<input id="tempOther" name="tempOther" class="hidden" type="text" placeholder="Enter Temperature Type" value="${data.temp_type==='Other'?data.tempOther:''}">

<label>Shipping Temperature</label>
<input
  id="shipTemp"
  type="number"
  step="0.1"
  name="shipping_temp"
  value="${data.shipping_temp || ''}"
  oninput="checkTemp()"
  ${isDriver || isLab ? "readonly" : ""}
>
<div id="shipTempMsg" style="font-size:13px;margin-top:3px;"></div>

<label>Delivery Temperature</label>
<input
  id="delTemp"
  type="number"
  step="0.1"
  name="delivery_temp"
  value="${data.delivery_temp || ''}"
  oninput="checkTemp()"
  ${isSite || isLab ? "readonly" : ""}
>
<div id="delTempMsg" style="font-size:13px;margin-top:3px;"></div>

<label>Tube Count Collected</label>
<input 
  id="collected"
  type="number"
  name="sample_count_collected"
  value="${data.sample_count_collected || ''}"
  ${isSite || isLab ? "readonly" : ""}
  oninput="checkTubes()"
>
<label>Tube Count Delivered</label>
<input 
  id="delivered"
  type="number"
  name="sample_count_delivered"
  value="${data.sample_count_delivered || ''}"
  ${isSite || isLab ? "readonly" : ""}
  oninput="checkTubes()"
>
<div id="discrepancyDiv" class="hidden">

<label>Tube Discrepancy Reason</label>
<input name="discrepancy_reason" value="${data.discrepancy_reason || ''}">

</div>

<label>Visit Number</label>
<input name="visit_number" value="${data.visit_number || ''}" ${isDriver ? "disabled" : ""}${isLab ? "disabled" : ""}>

<label>Collection Date & Time</label>
<input id="collectionTime" type="datetime-local" name="collection_datetime" value="${data.collection_datetime || ''}" ${isSite ? "" : "disabled"}>

<label>Receiver</label>
<select name="receiver" onchange="toggleOther(this,'receiverOther')" ${isSite ? "disabled" : ""}${isDriver ? "disabled" : ""}>
  <option ${data.receiver==='Natasha.G'?'selected':''}>Natasha.G</option>
  <option ${data.receiver==='Drew.M'?'selected':''}>Drew.M</option>
  <option ${data.receiver==='Lameez.P'?'selected':''}>Lameez.P</option>
  <option ${data.receiver==='Nthabiseng'?'selected':''}>Nthabiseng</option>
  <option ${data.receiver==='Viola'?'selected':''}>Viola</option>
  <option ${data.receiver==='Other'?'selected':''}>Other</option>
</select>
<input id="receiverOther" name="receiverOther" class="hidden" type="text" placeholder="Enter Receiver Name" value="${data.receiver==='Other'?data.receiverOther:''}">

<label>Receiving Date & Time</label>
<input id="receivingTime" type="datetime-local" name="receiving_datetime" value="${data.receiving_datetime || ''}" ${isSite ? "" : "disabled"}><div id="timeErrorMsg" style="font-size:13px;margin-top:3px;"></div>

<label>Sample Status</label>
<select name="sample_status" ${isSite ? "disabled" : ""}${isDriver ? "disabled" : ""}>
  <option value="" ${!data.sample_status?'selected':''}>-- None Selected --</option>
  <option ${data.sample_status==='Testing'?'selected':''}>Testing</option>
  <option ${data.sample_status==='Storage'?'selected':''}>Storage</option>
  <option ${data.sample_status==='Disposed'?'selected':''}>Disposed</option>
</select>

<button type="submit">Generate eCOC</button>

${data.id ? `
<div style="margin-top:10px;">
    <a href="/download/${data.id}" style="
        display:block;
        text-align:center;
        padding:10px;
        background:#27ae60;
        color:white;
        border-radius:5px;
        text-decoration:none;
        margin-top:10px;
    ">
        Download PDF
    </a>
</div>
` : ""}
<div id="statusBar" style="
  margin-top:20px;
  padding:10px;
  background:#eef6ff;
  border-radius:5px;
  font-size:14px;
  display:flex;
  justify-content:space-between;
  box-shadow:0 2px 4px rgba(0,0,0,0.1);
">
  <span>Collection: <span id="statusCollection">-</span></span>
  <span>In Transit: <span id="statusTransit">-</span></span>
  <span>Receiving: <span id="statusReceiving">-</span></span>
</div>
</form>

<script>

function updateStatusBar(){
    const collectionField = document.getElementById("collectionTime");
    const receivingField = document.getElementById("receivingTime");

    const statusCollection = document.getElementById("statusCollection");
    const statusTransit = document.getElementById("statusTransit");
    const statusReceiving = document.getElementById("statusReceiving");

    const collection = new Date(collectionField.value);
    const receiving = new Date(receivingField.value);
    const now = new Date();

    // Display collection time
    statusCollection.textContent = collectionField.value ? collection.toLocaleString() : "-";

    // Display receiving time
    statusReceiving.textContent = receivingField.value ? receiving.toLocaleString() : "-";

    // Compute transit
    if(collectionField.value){
        const endTime = receivingField.value ? receiving : now;
        let diffMs = endTime - collection;
        if(diffMs < 0) diffMs = 0;
        const hours = Math.floor(diffMs/(1000*60*60));
        const minutes = Math.floor((diffMs%(1000*60*60))/(1000*60));
        statusTransit.textContent = hours + "h " + minutes + "m";
    } else {
        statusTransit.textContent = "-";
    }
}

// Update whenever user changes collection or receiving time
document.getElementById("collectionTime").addEventListener("input", updateStatusBar);
document.getElementById("receivingTime").addEventListener("input", updateStatusBar);

// Initialize on page load
updateStatusBar();
function checkTransitTime(){

const collectionField = document.getElementById("collectionTime");
const receivingField = document.getElementById("receivingTime");

const msg = document.getElementById("timeErrorMsg");

receivingField.classList.remove("time-invalid");

const collection = new Date(collectionField.value);
const receiving = new Date(receivingField.value);

if(!collectionField.value || !receivingField.value){
msg.innerHTML="";
return;
}

if(receiving < collection){

msg.innerHTML="⚠ Receiving time cannot be before collection time";
msg.style.color="red";

receivingField.classList.add("time-invalid");

}else{

msg.innerHTML="✓ Time sequence valid";
msg.style.color="green";

}

}
function checkTemp() {

const type = document.querySelector('[name="temp_type"]').value;

const shipField = document.getElementById("shipTemp");
const delField = document.getElementById("delTemp");

const shipMsg = document.getElementById("shipTempMsg");
const delMsg = document.getElementById("delTempMsg");

if (!shipField || !delField) return;

const shipTemp = parseFloat(shipField.value);
const delTemp = parseFloat(delField.value);

function validate(temp, field, msg) {

    field.classList.remove("temp-valid", "temp-invalid");

    if (isNaN(temp)) {
        msg.innerHTML = "";
        return;
    }

    let min = 0, max = 0;

    if (type === "Ambient") {
        min = 15; max = 25;
    }

    if (type === "Refrigerated") {
        min = 2; max = 8;
    }

    if (temp < min) {
        msg.innerHTML = ` BELOW range (${min}-${max}°C)`;
        msg.style.color = "red";
        field.classList.add("temp-invalid");
    }
    else if (temp > max) {
        msg.innerHTML = ` ABOVE range (${min}-${max}°C)`;
        msg.style.color = "red";
        field.classList.add("temp-invalid");
    }
    else {
        msg.innerHTML = "✓ Within range";
        msg.style.color = "green";
        field.classList.add("temp-valid");
    }
}

validate(shipTemp, shipField, shipMsg);
validate(delTemp, delField, delMsg);
}

function checkTubes() {

const collected = document.getElementById("collected");
const delivered = document.getElementById("delivered");
const discrepancyDiv = document.getElementById("discrepancyDiv");

if (!collected || !delivered) return;

const c = parseInt(collected.value);
const d = parseInt(delivered.value);

if (!isNaN(c) && !isNaN(d) && c !== d) {
    discrepancyDiv.style.display = "block";
} else {
    discrepancyDiv.style.display = "none";
}
}

</script>

</body>
</html>
`;
}

// GET login page
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

// POST login form
app.post("/login", express.urlencoded({ extended: true }), (req, res) => {
    const { role, password } = req.body;

  if (users[role] && password === users[role]) {
    res.redirect(`/search?role=${role}`); // <-- go to search page instead of form
} else {
    res.send(`<h3>Invalid role or password. <a href='/login'>Try again</a></h3>`);
}
}); 
// ---------------- STEP 1: SEARCH / NEW FORM PAGE ----------------
app.get("/search", (req, res) => {
    const role = req.query.role || 'site'; // default role if not provided

    res.send(`
    <html>
    <head>
        <title>eCOC Options</title>
        <style>
            body { font-family: Arial; padding: 50px; text-align: center; background:#f4f6f9; }
            input, select, button { padding: 10px; margin: 10px; width: 250px; }
            button { background:#2c3e50; color:white; border:none; border-radius:5px; cursor:pointer; }
            hr { margin:30px 0; }
        </style>
    </head>
    <body>
        <h2>eCOC Options</h2>

        <!-- Load Existing eCOC -->
        <form method="GET" action="/load">
            <label>Load Existing eCOC</label><br>
            <input name="reqnum" placeholder="Enter Requisition Number"><br>
            <input type="hidden" name="role" value="${role}">
            <button type="submit">Load Form</button>
        </form>

        <hr>

        <!-- Start New eCOC -->
        <form method="GET" action="/form">
            <input type="hidden" name="role" value="${role}">
            <button type="submit">Start New eCOC</button>
        </form>
    </body>
    </html>
    `);
});
// ---------------- STEP 2: LOAD FORM BY REQUISITION NUMBER ----------------
app.get("/load", (req, res) => {
    const { reqnum, role } = req.query;

    if (!reqnum || !role || !["site","driver","lab"].includes(role)) {
        return res.send("Invalid requisition number or role");
    }

    db.get("SELECT * FROM samples WHERE requisition_number = ?", [reqnum], (err, row) => {
        if (err) return res.send("DB Error: " + err.message);

        if (!row) {
            // If no record exists, only allow Site to start a new form
            if(role === 'site'){
                return res.redirect(`/form?role=${role}&newReq=${reqnum}`);
            } else {
                return res.send(`No record found for Requisition Number: ${reqnum}`);
            }
        }

        // Load form with existing data — any role can access
        res.redirect(`/form/${row.id}?role=${role}`);
    });
});
// GET form with role query
app.get("/form", (req, res) => {
    const role = req.query.role;
    const newReq = req.query.newReq;  // <-- added

    if (!role || !["site","driver","lab"].includes(role)) {
        return res.redirect("/login");
    }

    // Pre-fill requisition_number if starting new
    const data = newReq ? { requisition_number: newReq } : {};
    res.send(renderForm(role, data));
});
app.get("/form/:id", (req, res) => {
    const role = req.query.role;
    const id = req.params.id;

    if (!role || !["site","driver","lab"].includes(role)) {
        return res.redirect("/login");
    }

    db.get("SELECT * FROM samples WHERE id = ?", [id], (err, row) => {
        if (err || !row) return res.send("Record not found");

        res.send(renderForm(role, row));
    });
});

// ---------------- ROUTES ----------------

app.get("/", (req, res) => res.redirect("/login"));
app.get("/view-pdfs", (req, res) => {
  const pdfDir = path.join(__dirname, "eCOC IC Labs");

  fs.readdir(pdfDir, (err, files) => {
    if (err) return res.send("Error reading PDF folder.");

    // Filter only .pdf files
    const pdfFiles = files.filter(f => f.endsWith(".pdf"));

    // Create a simple HTML page with links
    let html = "<h2>All eCOC PDFs</h2><ul>";
    pdfFiles.forEach(file => {
      html += `<li><a href="/pdfs/${file}" target="_blank">${file}</a></li>`;
    });
    html += "</ul>";

    res.send(html);
  });
});
app.get("/download/:id", (req, res) => {

    const id = req.params.id;

    const filePath = path.join(__dirname, "eCOC IC Labs", `eCOC_${id}.pdf`);

    if (fs.existsSync(filePath)) {
        return res.download(filePath, `eCOC_${id}.pdf`);
    } else {
        return res.send("PDF not found.");
    }
});

app.post("/add", async (req,res)=>{

const d=req.body;

const protocol=d.protocol_name==="Other"?d.protocolOther:d.protocol_name;
const site=d.site_name==="Other"?d.siteOther:d.site_name;
const shipper=d.shipped_by==="Other"?d.shipOther:d.shipped_by;
const courier=d.courier_name==="Other"?d.courierOther:d.courier_name;
const sampleType=d.sample_type==="Other"?d.sampleOther:d.sample_type;
const receiver=d.receiver==="Other"?d.receiverOther:d.receiver;
const tempType=d.temp_type==="Other"?d.tempOther:d.temp_type;

// ================= UPDATE EXISTING =================
if (d.id) {

    let query = "";
    let params = [];

    if (d.role === "site") {
        query = `
        UPDATE samples SET
        protocol_name=?, site_name=?, shipping_date=?, shipped_by=?,
        page_numbers=?, requisition_number=?, pid=?, sample_type=?,
        sample_count_collected=?, visit_number=?, collection_datetime=?
        WHERE id=?`;

        params = [
            protocol, site, d.shipping_date, shipper,
            d.page_numbers, d.requisition_number, d.pid, sampleType,
            d.sample_count_collected, d.visit_number, d.collection_datetime,
            d.id
        ];
    }

    else if (d.role === "driver") {
        query = `
        UPDATE samples SET
        courier_name=?, shipping_temp=?, temp_type=?,
        sample_count_delivered=?, discrepancy_reason=?
        WHERE id=?`;

        params = [
            courier, d.shipping_temp, tempType,
            d.sample_count_delivered, d.discrepancy_reason,
            d.id
        ];
    }

    else if (d.role === "lab") {
        query = `
        UPDATE samples SET
        receiver=?, receiving_datetime=?, delivery_temp=?, sample_status=?
        WHERE id=?`;

        params = [
            receiver, d.receiving_datetime, d.delivery_temp, d.sample_status,
            d.id
        ];
    }

    return db.run(query, params, function(err){
        if(err) return res.send("Update Error: " + err.message);
        return res.redirect(`/form/${d.id}?role=${d.role}`);
    });
}

// ================= INSERT NEW =================
else {

    return db.run(`
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
        d.visit_number,d.collection_datetime,receiver,d.receiving_datetime,d.sample_status
    ],
    async function(err){

        if(err) return res.send("DB Error: "+err.message);
// PDF CREATION



const folderPath=path.join(__dirname,"eCOC IC Labs");

if(!fs.existsSync(folderPath)) fs.mkdirSync(folderPath);

const year=new Date().getFullYear();
const docRefNum=`IC-${year}-${String(this.lastID).padStart(4,'0')}`;

const doc=new PDFDocument({margin:50});
const filePath=path.join(folderPath,`eCOC_${this.lastID}.pdf`);

doc.pipe(fs.createWriteStream(filePath));

const leftMargin=50;
const tableLabelWidth=160;
const tableValueX=leftMargin+tableLabelWidth;

// IC LABS LOGO

const icLogoPath=path.join(__dirname,'IC_Labs_Logo.png');

if(fs.existsSync(icLogoPath)){
doc.image(icLogoPath, doc.page.width/2 - 60, 5, {width:120});
doc.moveDown(5);
}

// BARCODE

try{

const pngBuffer=await bwipjs.toBuffer({
bcid:'code128',
text:docRefNum,
scale:1.2,
height:6,
includetext:false
});

doc.image(pngBuffer, doc.page.width-200, 50,{width:100});

}catch(err){}

doc.fontSize(10);

function addField(label,value){

doc.font('Helvetica-Bold').text(label+":",leftMargin,doc.y);
doc.font('Helvetica').text(value||"-",tableValueX,doc.y-10);
doc.moveDown(1);

}

addField("Document Ref Number",docRefNum);
addField("Protocol Name",protocol);
addField("Site Name",site);
addField("Shipping Date",formatDateTime(d.shipping_date));
addField("Shipped By",shipper);
addField("Courier Name",courier);
addField("Page Numbers",d.page_numbers);
addField("Requisition Number",d.requisition_number);
addField("PID",d.pid);
addField("Sample Type",sampleType);
addField("Temperature Type",tempType);
addField("Shipping Temperature",d.shipping_temp+" °C");
addField("Delivery Temperature",d.delivery_temp+" °C");
addField("Collection Date & Time",formatDateTime(d.collection_datetime));
addField("Receiver",receiver);
addField("Receiving Date & Time",formatDateTime(d.receiving_datetime));
// TIME IN TRANSIT

if(d.collection_datetime && d.receiving_datetime){

const collection = new Date(d.collection_datetime);
const receiving = new Date(d.receiving_datetime);

const diffMs = receiving - collection;

if(diffMs > 0){

const hours = Math.floor(diffMs / (1000 * 60 * 60));
const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

const transitTime = hours + " hours " + minutes + " minutes";

addField("Time in Transit", transitTime);

}

}

// STATUS

let status=d.sample_status;

if(!status){
status="In Transit";
}

addField("Sample Status",status);

// STORAGE TIMER

if(status==="Storage"){

const receiving=new Date(d.receiving_datetime);

if(!isNaN(receiving)){

const now=new Date();

const diffMs=now-receiving;

const hours=Math.floor(diffMs/(1000*60*60));
const minutes=Math.floor((diffMs%(1000*60*60))/(1000*60));

addField("Time in Storage",hours+" hours "+minutes+" minutes");

}

}

// RODON FOOTER

const rodonLogoPath=path.join(__dirname,'Rodon_Logo.png');

const centerX = doc.page.width / 2;

if(fs.existsSync(rodonLogoPath)){

doc.image(rodonLogoPath, centerX - 25, doc.page.height - 80, {width:50});

doc.fontSize(10)
.font('Helvetica-Bold')
.text("Sponsored by Rodon Global", centerX, doc.page.height - 65, {align:"center"});

}

doc.end();

res.redirect(`/form/${this.lastID}?role=${d.role}`);

   }
    );

  } // ✅ closes ELSE block
}); // ✅ 

if (!global.__portDeclared) {
    app.listen(PORT, () => console.log("Server running on port " + PORT));
    global.__portDeclared = true;
}