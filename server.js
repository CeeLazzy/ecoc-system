const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");
const bwipjs = require("bwip-js");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));
app.use("/pdfs", express.static(path.join(__dirname, "eCOC IC Labs")));

const users = {
    site: "site123",
    driver: "driver123",
    lab: "lab123"
};

const protocolOptions = ["TBD15-201", "Brilliant B011", "Align", "Transgender", "Other"];

const siteOptions = [
    "710-006 (Aurum Institute CRS)",
    "710-045 (WITS RHI-Shandukani Research)",
    "710-TASK Clinical Research Centre",
    "710-040 (Centre of Tuberculosis Research Innovation)",
    "Other"
];

const sampleTypeOptions = [
    "4ml EDTA",
    "6ml EDTA",
    "4ml SST",
    "Urine",
    "PK Plasma Aliquots",
    "Spot Sputum"
];

const db = new sqlite3.Database("./ecoc.db");

db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS coc_forms (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            protocol_name TEXT,
            site_name TEXT,
            shipping_date TEXT,
            courier_name TEXT,
            page_numbers TEXT,
            shipped_by TEXT,
            courier_collection_datetime TEXT,
            delivery_datetime TEXT,
            requisition_number TEXT UNIQUE,
            pid TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);

    db.run("ALTER TABLE coc_forms ADD COLUMN pid TEXT", err => {
        if (err && !err.message.includes("duplicate column name")) {
            console.error("PID column error:", err.message);
        }
    });

    db.run("ALTER TABLE coc_forms ADD COLUMN delivery_datetime TEXT", err => {
        if (err && !err.message.includes("duplicate column name")) {
            console.error("Delivery datetime column error:", err.message);
        }
    });

    db.run(`
        CREATE TABLE IF NOT EXISTS coc_sample_rows (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            form_id INTEGER,
            row_order INTEGER,
            sample_type TEXT,
            shipping_temp REAL,
            tubes_sent INTEGER,
            sample_collection_datetime TEXT,
            visit TEXT,
            courier_pickup_temp REAL,
            tubes_received INTEGER,
            receiver_initial_date TEXT,
            comments TEXT,
            delivery_temp REAL,
            FOREIGN KEY(form_id) REFERENCES coc_forms(id)
        )
    `);
});

function todayDate() {
    return new Date().toISOString().split("T")[0];
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function normalizeArray(value) {
    if (Array.isArray(value)) return value;
    if (value === undefined || value === null) return [];
    return [value];
}

function formatDateTime(dt) {
    return dt ? String(dt).replace("T", " ") : "";
}

function selected(value, expected) {
    return value === expected ? "selected" : "";
}

function checked(value, expected) {
    return value === expected ? "checked" : "";
}

function readonly(canEdit) {
    return canEdit ? "" : "readonly";
}

function disabled(canEdit) {
    return canEdit ? "" : "disabled";
}

function activeRoleClass(currentRole, fieldRole) {
    return currentRole === fieldRole ? `active-${fieldRole}` : "";
}

function renderOptions(options, currentValue) {
    return options.map(option => {
        return `<option value="${escapeHtml(option)}" ${selected(currentValue, option)}>${escapeHtml(option)}</option>`;
    }).join("");
}

function renderSiteOptions(currentValue, canEdit) {
    return siteOptions.map(site => {
        return `
            <label class="choice-line">
                <input type="radio" name="site_name" value="${escapeHtml(site)}" ${checked(currentValue, site)} ${disabled(canEdit)}>
                <span>${escapeHtml(site)}</span>
            </label>
        `;
    }).join("");
}

function renderSampleRows(role, rows) {
    const isSite = role === "site";
    const isDriver = role === "driver";
    const isLab = role === "lab";
    const usableRows = rows.length ? rows : [{}];

    return usableRows.map(row => {
        return `
            <tr class="sample-row">
                <td class="${activeRoleClass(role, "site")}">
                    <select name="sample_type[]" ${disabled(isSite)}>
                        ${renderOptions(sampleTypeOptions, row.sample_type)}
                    </select>
                    ${!isSite ? `<input type="hidden" name="sample_type[]" value="${escapeHtml(row.sample_type || "")}">` : ""}
                </td>

                <td class="${activeRoleClass(role, "site")}"><input type="number" step="0.1" name="shipping_temp[]" value="${escapeHtml(row.shipping_temp)}" ${readonly(isSite)}></td>
                <td class="${activeRoleClass(role, "site")}"><input type="number" name="tubes_sent[]" value="${escapeHtml(row.tubes_sent)}" ${readonly(isSite)}></td>
                <td class="${activeRoleClass(role, "site")}"><input type="datetime-local" name="sample_collection_datetime[]" value="${escapeHtml(row.sample_collection_datetime)}" ${readonly(isSite)}></td>
                <td class="${activeRoleClass(role, "site")}"><input name="visit[]" value="${escapeHtml(row.visit)}" ${readonly(isSite)}></td>

                <td class="${activeRoleClass(role, "driver")}"><input type="number" step="0.1" name="courier_pickup_temp[]" value="${escapeHtml(row.courier_pickup_temp)}" ${readonly(isDriver)}></td>

                <td class="${activeRoleClass(role, "lab")}"><input type="number" name="tubes_received[]" value="${escapeHtml(row.tubes_received)}" ${readonly(isLab)}></td>
                <td class="${activeRoleClass(role, "lab")}"><input name="receiver_initial_date[]" value="${escapeHtml(row.receiver_initial_date)}" ${readonly(isLab)}></td>
                <td class="${activeRoleClass(role, "lab")}"><input name="comments[]" value="${escapeHtml(row.comments)}" ${readonly(isLab)}></td>
                <td class="${activeRoleClass(role, "lab")}"><input type="number" step="0.1" name="delivery_temp[]" value="${escapeHtml(row.delivery_temp)}" ${readonly(isLab)}></td>

                ${isSite ? `
                    <td class="action-cell">
                        <button type="button" class="small-button danger" onclick="removeSampleRow(this)">Remove</button>
                    </td>
                ` : ""}
            </tr>
        `;
    }).join("");
}

function renderForm(role, form = {}, rows = []) {
    const isSite = role === "site";
    const isDriver = role === "driver";
    const isLab = role === "lab";

    const protocolIsOther = form.protocol_name && !protocolOptions.includes(form.protocol_name);
    const siteIsOther = form.site_name && !siteOptions.includes(form.site_name);

    return `
<html>
<head>
<title>IC Labs eCOC</title>

<style>
body{
    font-family:Arial, sans-serif;
    margin:0;
    padding:10px;
    background:#dfe4ea;
    color:#1f2933;
}

.form-shell{
    width:1120px;
    min-height:790px;
    margin:auto;
    background:white;
    padding:16px;
    border-radius:0;
    box-shadow:0 4px 10px rgba(0,0,0,0.12);
    box-sizing:border-box;
}

.header{
    display:grid;
    grid-template-columns:220px 1fr 300px;
    align-items:start;
    gap:12px;
    margin-bottom:10px;
}

.logo{
    width:135px;
}

.title{
    text-align:center;
    font-size:20px;
    font-weight:bold;
    padding-top:18px;
}

.contact{
    font-size:11px;
    line-height:1.3;
    text-align:right;
}

table{
    width:100%;
    border-collapse:collapse;
    margin-top:8px;
    table-layout:fixed;
}

th,td{
    border:1px solid #9aa6b2;
    padding:4px;
    vertical-align:top;
}

th{
    background:#e8eef5;
    font-size:10px;
    text-align:center;
}

label{
    font-weight:bold;
    display:block;
    margin-bottom:3px;
    font-size:11px;
}

input,select,textarea{
    width:100%;
    box-sizing:border-box;
    padding:4px;
    border:1px solid #b7c0ca;
    border-radius:3px;
    font-size:11px;
}

input[readonly]{
    background:#f1f3f5;
}

.active-site{
    background:#dff0ff;
}

.active-driver{
    background:#fff2b8;
}

.active-lab{
    background:#dff8e8;
}

.role-key{
    display:flex;
    gap:10px;
    margin:8px 0;
    font-size:11px;
    align-items:center;
}

.role-key span{
    display:inline-flex;
    align-items:center;
    gap:4px;
}

.role-dot{
    width:12px;
    height:12px;
    border:1px solid #9aa6b2;
    display:inline-block;
}

.dot-site{
    background:#dff0ff;
}

.dot-driver{
    background:#fff2b8;
}

.dot-lab{
    background:#dff8e8;
}

.choice-group{
    border:1px solid #b7c0ca;
    border-radius:3px;
    padding:4px;
    background:#fff;
    font-size:10px;
}

.choice-line{
    font-weight:normal;
    display:flex;
    gap:5px;
    align-items:flex-start;
    margin:3px 0;
}

.choice-line input{
    width:auto;
    margin-top:1px;
}

.note-cell{
    font-weight:bold;
    line-height:1.3;
    background:#fff7e6;
    font-size:11px;
}

.main-grid{
    display:grid;
    grid-template-columns:150px 1fr;
    gap:8px;
    align-items:start;
}

.requisition-box{
    min-height:150px;
}

.table-scroll{
    overflow:visible;
}

.sample-table{
    table-layout:fixed;
}

.sample-table th{
    font-size:9px;
    line-height:1.1;
}

.sample-table td{
    padding:3px;
}

.sample-table input,
.sample-table select{
    min-width:0;
    font-size:10px;
    padding:3px;
}

.sample-table th:nth-child(1){width:90px;}
.sample-table th:nth-child(2){width:55px;}
.sample-table th:nth-child(3){width:55px;}
.sample-table th:nth-child(4){width:95px;}
.sample-table th:nth-child(5){width:45px;}
.sample-table th:nth-child(6){width:65px;}
.sample-table th:nth-child(7){width:55px;}
.sample-table th:nth-child(8){width:85px;}
.sample-table th:nth-child(9){width:85px;}
.sample-table th:nth-child(10){width:55px;}
.sample-table th:nth-child(11){width:55px;}

.action-cell{
    width:55px;
    text-align:center;
}

.button-row{
    display:flex;
    gap:10px;
    margin-top:12px;
}

button,.button-link{
    padding:8px 12px;
    background:#2c3e50;
    color:white;
    border:none;
    border-radius:4px;
    cursor:pointer;
    text-decoration:none;
    text-align:center;
    font-size:13px;
}

button.primary{
    flex:1;
}

.small-button{
    padding:5px 6px;
    font-size:10px;
}

.danger{
    background:#b42318;
}

.success{
    background:#218838;
}

.hidden{
    display:none;
}

@page{
    size:A4 landscape;
    margin:8mm;
}

@media print{
    body{
        background:white;
        padding:0;
    }

    .form-shell{
        width:100%;
        min-height:auto;
        box-shadow:none;
        padding:0;
    }

    .button-row,
    .role-key{
        display:none;
    }
}
</style>
</head>

<body>
<div class="form-shell">
<form method="POST" action="/add">
<input type="hidden" name="id" value="${escapeHtml(form.id)}">
<input type="hidden" name="role" value="${escapeHtml(role)}">

<div class="header">
    <div><img src="/IC_Labs_Logo.png" class="logo"></div>

    <div class="title">Electronic Chain of Custody Form</div>

    <div class="contact">
        <strong>IC Labs Contact Information:</strong><br>
        0211407190<br>
        info@iclabs.co.za<br>
        Ground Floor Albion Springs<br>
        183 Main Road, Rondebosch<br>
        Cape Town, Western Cape, South Africa
    </div>
</div>

<div class="role-key">
    <span><i class="role-dot dot-site"></i> Site fields</span>
    <span><i class="role-dot dot-driver"></i> Driver fields</span>
    <span><i class="role-dot dot-lab"></i> Lab fields</span>
</div>

<table>
    <tr>
        <td class="${activeRoleClass(role, "site")}">
            <label>Protocol Name</label>
            <select name="protocol_name" onchange="toggleOther(this,'protocolOther')" ${disabled(isSite)}>
                ${renderOptions(protocolOptions, protocolIsOther ? "Other" : form.protocol_name)}
            </select>
            ${!isSite ? `<input type="hidden" name="protocol_name" value="${escapeHtml(form.protocol_name || "")}">` : ""}
            <input id="protocolOther" name="protocolOther" class="${protocolIsOther ? "" : "hidden"}" value="${protocolIsOther ? escapeHtml(form.protocol_name) : ""}" placeholder="Enter protocol">
        </td>

        <td class="${activeRoleClass(role, "site")}">
            <label>Shipping Date</label>
            <input type="date" name="shipping_date" value="${escapeHtml(form.shipping_date || todayDate())}" ${readonly(isSite)}>
        </td>

        <td class="${activeRoleClass(role, "driver")}">
            <label>Courier Name</label>
            <input name="courier_name" value="${escapeHtml(form.courier_name)}" ${readonly(isDriver)}>
        </td>

        <td class="${activeRoleClass(role, "site")}">
            <label>Number of Pages</label>
            <input type="number" name="page_numbers" value="${escapeHtml(form.page_numbers)}" ${readonly(isSite)}>
        </td>
    </tr>

    <tr>
        <td class="${activeRoleClass(role, "site")}">
            <label>Site Name</label>
            <div class="choice-group">
                ${renderSiteOptions(siteIsOther ? "Other" : form.site_name, isSite)}
            </div>
            ${!isSite ? `<input type="hidden" name="site_name" value="${escapeHtml(form.site_name || "")}">` : ""}
            <input id="siteOther" name="siteOther" class="${siteIsOther ? "" : "hidden"}" value="${siteIsOther ? escapeHtml(form.site_name) : ""}" placeholder="Enter site">
        </td>

        <td class="${activeRoleClass(role, "site")}">
            <label>Shipped By</label>
            <input name="shipped_by" value="${escapeHtml(form.shipped_by)}" ${readonly(isSite)} placeholder="Name and surname">
        </td>

        <td class="${activeRoleClass(role, "driver")}">
            <label>Courier Collection Date & Time</label>
            <input type="datetime-local" name="courier_collection_datetime" value="${escapeHtml(form.courier_collection_datetime)}" ${readonly(isDriver)}>
        </td>

        <td class="${activeRoleClass(role, "lab")}">
            <label>Delivery Date & Time</label>
            <input type="datetime-local" name="delivery_datetime" value="${escapeHtml(form.delivery_datetime)}" ${readonly(isLab)}>
        </td>
    </tr>

    <tr>
        <td colspan="4" class="note-cell">
            Note: This log must physically accompany the samples.
        </td>
    </tr>
</table>

<div class="main-grid">
    <table class="requisition-box ${activeRoleClass(role, "site")}">
        <tr><th>Requisition Number</th></tr>
        <tr>
            <td>
                <input name="requisition_number" value="${escapeHtml(form.requisition_number)}" ${readonly(isSite)}>
            </td>
        </tr>

        <tr><th>PID Number</th></tr>
        <tr>
            <td>
                <input name="pid" value="${escapeHtml(form.pid)}" ${readonly(isSite)}>
            </td>
        </tr>
    </table>

    <div class="table-scroll">
        <table class="sample-table" id="sampleTable">
            <thead>
                <tr>
                    <th class="${activeRoleClass(role, "site")}">Sample Type</th>
                    <th class="${activeRoleClass(role, "site")}">Ship Temp</th>
                    <th class="${activeRoleClass(role, "site")}">Tubes Sent</th>
                    <th class="${activeRoleClass(role, "site")}">Sample Collection Date/Time</th>
                    <th class="${activeRoleClass(role, "site")}">Visit</th>
                    <th class="${activeRoleClass(role, "driver")}">Pickup Temp</th>
                    <th class="${activeRoleClass(role, "lab")}">Tubes Rec.</th>
                    <th class="${activeRoleClass(role, "lab")}">Receiver Initial/Date</th>
                    <th class="${activeRoleClass(role, "lab")}">Comments</th>
                    <th class="${activeRoleClass(role, "lab")}">Delivery Temp</th>
                    ${isSite ? `<th>Action</th>` : ""}
                </tr>
            </thead>
            <tbody id="sampleRows">
                ${renderSampleRows(role, rows)}
            </tbody>
        </table>
    </div>
</div>

<div class="button-row">
    ${isSite ? `<button type="button" onclick="addSampleRow()">Add Sample Type</button>` : ""}
    <button class="primary" type="submit">Save eCOC</button>
    ${form.id ? `<a class="button-link success" href="/download/${form.id}">Download PDF</a>` : ""}
</div>

</form>
</div>

<script>
function toggleOther(select, inputId){
    const input = document.getElementById(inputId);
    if(!input) return;

    if(select.value === "Other"){
        input.classList.remove("hidden");
    } else {
        input.classList.add("hidden");
        input.value = "";
    }
}

document.querySelectorAll('input[name="site_name"]').forEach(input => {
    input.addEventListener("change", () => {
        const other = document.getElementById("siteOther");
        if(!other) return;

        if(input.value === "Other" && input.checked){
            other.classList.remove("hidden");
        } else if(input.checked) {
            other.classList.add("hidden");
            other.value = "";
        }
    });
});

function addSampleRow(){
    const tbody = document.getElementById("sampleRows");
    const tr = document.createElement("tr");
    tr.className = "sample-row";

    tr.innerHTML = \`
        <td class="${activeRoleClass(role, "site")}">
            <select name="sample_type[]">
                <option value="4ml EDTA">4ml EDTA</option>
                <option value="6ml EDTA">6ml EDTA</option>
                <option value="4ml SST">4ml SST</option>
                <option value="Urine">Urine</option>
                <option value="PK Plasma Aliquots">PK Plasma Aliquots</option>
                <option value="Spot Sputum">Spot Sputum</option>
            </select>
        </td>
        <td class="${activeRoleClass(role, "site")}"><input type="number" step="0.1" name="shipping_temp[]"></td>
        <td class="${activeRoleClass(role, "site")}"><input type="number" name="tubes_sent[]"></td>
        <td class="${activeRoleClass(role, "site")}"><input type="datetime-local" name="sample_collection_datetime[]"></td>
        <td class="${activeRoleClass(role, "site")}"><input name="visit[]"></td>
        <td class="${activeRoleClass(role, "driver")}"><input type="number" step="0.1" name="courier_pickup_temp[]" readonly></td>
        <td class="${activeRoleClass(role, "lab")}"><input type="number" name="tubes_received[]" readonly></td>
        <td class="${activeRoleClass(role, "lab")}"><input name="receiver_initial_date[]" readonly></td>
        <td class="${activeRoleClass(role, "lab")}"><input name="comments[]" readonly></td>
        <td class="${activeRoleClass(role, "lab")}"><input type="number" step="0.1" name="delivery_temp[]" readonly></td>
        <td class="action-cell"><button type="button" class="small-button danger" onclick="removeSampleRow(this)">Remove</button></td>
    \`;

    tbody.appendChild(tr);
}

function removeSampleRow(button){
    const rows = document.querySelectorAll(".sample-row");
    if(rows.length <= 1) return;
    button.closest("tr").remove();
}
</script>

</body>
</html>
`;
}

function getFormWithRows(id, callback) {
    db.get("SELECT * FROM coc_forms WHERE id = ?", [id], (err, form) => {
        if (err || !form) return callback(err || new Error("Record not found"));

        db.all(
            "SELECT * FROM coc_sample_rows WHERE form_id = ? ORDER BY row_order, id",
            [id],
            (rowErr, rows) => {
                if (rowErr) return callback(rowErr);
                callback(null, form, rows);
            }
        );
    });
}

function saveSampleRows(formId, d, callback) {
    const sampleTypes = normalizeArray(d.sample_type);
    const shippingTemps = normalizeArray(d.shipping_temp);
    const tubesSent = normalizeArray(d.tubes_sent);
    const collectionTimes = normalizeArray(d.sample_collection_datetime);
    const visits = normalizeArray(d.visit);
    const pickupTemps = normalizeArray(d.courier_pickup_temp);
    const tubesReceived = normalizeArray(d.tubes_received);
    const receiverInitialDates = normalizeArray(d.receiver_initial_date);
    const comments = normalizeArray(d.comments);
    const deliveryTemps = normalizeArray(d.delivery_temp);

    db.run("DELETE FROM coc_sample_rows WHERE form_id = ?", [formId], err => {
        if (err) return callback(err);

        const stmt = db.prepare(`
            INSERT INTO coc_sample_rows (
                form_id,row_order,sample_type,shipping_temp,tubes_sent,
                sample_collection_datetime,visit,courier_pickup_temp,
                tubes_received,receiver_initial_date,comments,delivery_temp
            )
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        `);

        for (let i = 0; i < sampleTypes.length; i++) {
            stmt.run([
                formId,
                i,
                sampleTypes[i],
                shippingTemps[i],
                tubesSent[i],
                collectionTimes[i],
                visits[i],
                pickupTemps[i],
                tubesReceived[i],
                receiverInitialDates[i],
                comments[i],
                deliveryTemps[i]
            ]);
        }

        stmt.finalize(callback);
    });
}

function saveRowsDirectly(formId, rows, callback) {
    db.run("DELETE FROM coc_sample_rows WHERE form_id = ?", [formId], err => {
        if (err) return callback(err);

        const stmt = db.prepare(`
            INSERT INTO coc_sample_rows (
                form_id,row_order,sample_type,shipping_temp,tubes_sent,
                sample_collection_datetime,visit,courier_pickup_temp,
                tubes_received,receiver_initial_date,comments,delivery_temp
            )
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        `);

        rows.forEach((row, index) => {
            stmt.run([
                formId,
                index,
                row.sample_type,
                row.shipping_temp,
                row.tubes_sent,
                row.sample_collection_datetime,
                row.visit,
                row.courier_pickup_temp,
                row.tubes_received,
                row.receiver_initial_date,
                row.comments,
                row.delivery_temp
            ]);
        });

        stmt.finalize(callback);
    });
}

function mergeRowsForRole(role, d, existingRows) {
    const sampleTypes = normalizeArray(d.sample_type);
    const shippingTemps = normalizeArray(d.shipping_temp);
    const tubesSent = normalizeArray(d.tubes_sent);
    const collectionTimes = normalizeArray(d.sample_collection_datetime);
    const visits = normalizeArray(d.visit);
    const pickupTemps = normalizeArray(d.courier_pickup_temp);
    const tubesReceived = normalizeArray(d.tubes_received);
    const receiverInitialDates = normalizeArray(d.receiver_initial_date);
    const comments = normalizeArray(d.comments);
    const deliveryTemps = normalizeArray(d.delivery_temp);

    const rowCount = Math.max(sampleTypes.length, existingRows.length, 1);
    const rows = [];

    for (let i = 0; i < rowCount; i++) {
        const old = existingRows[i] || {};

        rows.push({
            sample_type: role === "site" ? sampleTypes[i] : old.sample_type,
            shipping_temp: role === "site" ? shippingTemps[i] : old.shipping_temp,
            tubes_sent: role === "site" ? tubesSent[i] : old.tubes_sent,
            sample_collection_datetime: role === "site" ? collectionTimes[i] : old.sample_collection_datetime,
            visit: role === "site" ? visits[i] : old.visit,
            courier_pickup_temp: role === "driver" ? pickupTemps[i] : old.courier_pickup_temp,
            tubes_received: role === "lab" ? tubesReceived[i] : old.tubes_received,
            receiver_initial_date: role === "lab" ? receiverInitialDates[i] : old.receiver_initial_date,
            comments: role === "lab" ? comments[i] : old.comments,
            delivery_temp: role === "lab" ? deliveryTemps[i] : old.delivery_temp
        });
    }

    return rows;
}

async function generatePdf(formId) {
    return new Promise((resolve, reject) => {
        getFormWithRows(formId, async (err, form, rows) => {
            if (err) return reject(err);

            const folderPath = path.join(__dirname, "eCOC IC Labs");
            if (!fs.existsSync(folderPath)) fs.mkdirSync(folderPath);

            const year = new Date().getFullYear();
            const docRefNum = `IC-${year}-${String(formId).padStart(4, "0")}`;
            const filePath = path.join(folderPath, `eCOC_${formId}.pdf`);

            const doc = new PDFDocument({ margin: 24, size: "A4", layout: "landscape" });
            const stream = fs.createWriteStream(filePath);
            doc.pipe(stream);

            const navy = "#1f3a5f";
            const paleBlue = "#edf4fb";
            const lightGrey = "#f5f7fa";
            const border = "#9aa6b2";
            const text = "#202833";

            function cell(x, y, w, h, label, value, options = {}) {
                const fill = options.fill || "#ffffff";
                doc.rect(x, y, w, h).fillAndStroke(fill, border);
                doc.fillColor(navy).font("Helvetica-Bold").fontSize(6.5)
                    .text(label, x + 4, y + 4, { width: w - 8 });
                doc.fillColor(text).font("Helvetica").fontSize(options.valueSize || 7.5)
                    .text(value || "-", x + 4, y + 16, { width: w - 8, height: h - 18 });
            }

            function tableHeader(x, y, widths, headers) {
                let cx = x;
                doc.font("Helvetica-Bold").fontSize(5.8).fillColor("#ffffff");
                headers.forEach((h, i) => {
                    doc.rect(cx, y, widths[i], 24).fillAndStroke(navy, border);
                    doc.fillColor("#ffffff").text(h, cx + 2, y + 6, { width: widths[i] - 4, align: "center" });
                    cx += widths[i];
                });
            }

            const logoPath = path.join(__dirname, "IC_Labs_Logo.png");

            doc.rect(0, 0, doc.page.width, 78).fill("#ffffff");
            doc.moveTo(24, 78).lineTo(doc.page.width - 24, 78).strokeColor(border).stroke();

            if (fs.existsSync(logoPath)) {
                doc.image(logoPath, 26, 18, { width: 82 });
            }

            doc.fillColor(navy)
                .font("Helvetica-Bold")
                .fontSize(17)
                .text("Electronic Chain of Custody Form", 0, 26, { align: "center" });

            doc.fillColor(text)
                .font("Helvetica")
                .fontSize(7)
                .text(
                    "IC Labs Contact Information:\n0211407190 | info@iclabs.co.za\nGround Floor Albion Springs\n183 Main Road, Rondebosch\nCape Town, Western Cape, South Africa",
                    585,
                    16,
                    { width: 230, align: "right", lineGap: 1 }
                );

            try {
                const pngBuffer = await bwipjs.toBuffer({
                    bcid: "code128",
                    text: docRefNum,
                    scale: 1.1,
                    height: 6,
                    includetext: false
                });

                doc.image(pngBuffer, 681, 84, { width: 110 });
            } catch (e) {}

            doc.fillColor(navy).font("Helvetica-Bold").fontSize(8)
                .text(`Document Ref: ${docRefNum}`, 24, 86);

            const startY = 108;
            const cellW = 197;
            const cellH = 34;

            cell(24, startY, cellW, cellH, "Protocol Name", form.protocol_name, { fill: paleBlue });
            cell(24 + cellW, startY, cellW, cellH, "Shipping Date", form.shipping_date, { fill: paleBlue });
            cell(24 + cellW * 2, startY, cellW, cellH, "Courier Name", form.courier_name, { fill: paleBlue });
            cell(24 + cellW * 3, startY, cellW, cellH, "Number of Pages", form.page_numbers, { fill: paleBlue });

            cell(24, startY + cellH, cellW, cellH, "Site Name", form.site_name, { fill: lightGrey, valueSize: 6.6 });
            cell(24 + cellW, startY + cellH, cellW, cellH, "Shipped By", form.shipped_by, { fill: lightGrey });
            cell(24 + cellW * 2, startY + cellH, cellW, cellH, "Courier Collection Date & Time", formatDateTime(form.courier_collection_datetime), { fill: lightGrey });
            cell(24 + cellW * 3, startY + cellH, cellW, cellH, "Delivery Date & Time", formatDateTime(form.delivery_datetime), { fill: lightGrey });

            cell(24, startY + cellH * 2, cellW * 4, 24, "Important Note", "This log must physically accompany the samples.", { fill: "#fff7df" });

            const reqY = startY + cellH * 2 + 38;
            cell(24, reqY, 132, 36, "Requisition Number", form.requisition_number, { fill: paleBlue, valueSize: 8.5 });
            cell(24, reqY + 36, 132, 36, "PID Number", form.pid, { fill: paleBlue, valueSize: 8.5 });

            const tableX = 166;
            let tableY = reqY;

            const headers = [
                "Sample Type", "Ship Temp", "Tubes Sent", "Collection Date/Time", "Visit",
                "Pickup Temp", "Tubes Rec.", "Receiver Initial/Date", "Comments", "Delivery Temp"
            ];

            const widths = [82, 54, 52, 96, 42, 58, 54, 88, 92, 54];

            tableHeader(tableX, tableY, widths, headers);
            tableY += 24;

            doc.font("Helvetica").fontSize(5.8).fillColor(text);

            rows.forEach((row, index) => {
                let x = tableX;
                const rowH = 29;
                const fill = index % 2 === 0 ? "#ffffff" : "#f8fafc";

                const values = [
                    row.sample_type,
                    row.shipping_temp,
                    row.tubes_sent,
                    formatDateTime(row.sample_collection_datetime),
                    row.visit,
                    row.courier_pickup_temp,
                    row.tubes_received,
                    row.receiver_initial_date,
                    row.comments,
                    row.delivery_temp
                ];

                values.forEach((value, i) => {
                    doc.rect(x, tableY, widths[i], rowH).fillAndStroke(fill, border);
                    doc.fillColor(text).font("Helvetica").fontSize(5.8)
                        .text(value || "-", x + 2, tableY + 5, { width: widths[i] - 4, height: rowH - 8 });
                    x += widths[i];
                });

                tableY += rowH;
            });

            const footerY = 560;
            doc.moveTo(24, footerY).lineTo(doc.page.width - 24, footerY).strokeColor(border).stroke();
            doc.fillColor("#5b6775").font("Helvetica").fontSize(6.5)
                .text("Generated electronically by IC Labs eCOC system. Review all entered details before releasing samples.", 24, footerY + 8, {
                    width: doc.page.width - 48,
                    align: "center"
                });

            doc.end();

            stream.on("finish", resolve);
            stream.on("error", reject);
        });
    });
}

app.get("/", (req, res) => {
    res.redirect("/login");
});

app.get("/login", (req, res) => {
    res.send(`
<html>
<head>
<title>eCOC Login</title>
<style>
body{font-family:Arial;padding:50px;background:#f4f6f9;text-align:center;}
input,select,button{padding:10px;margin:10px;width:220px;}
button{background:#2c3e50;color:white;border:none;border-radius:5px;cursor:pointer;}
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

    if (users[role] && password === users[role]) {
        return res.redirect(`/search?role=${role}`);
    }

    res.send(`<h3>Invalid role or password. <a href="/login">Try again</a></h3>`);
});

app.get("/search", (req, res) => {
    const role = req.query.role || "site";

    if (!["site", "driver", "lab"].includes(role)) {
        return res.redirect("/login");
    }

    res.send(`
<html>
<head>
<title>eCOC Options</title>
<style>
body{font-family:Arial;padding:50px;text-align:center;background:#f4f6f9;}
input,button{padding:10px;margin:10px;width:260px;}
button{background:#2c3e50;color:white;border:none;border-radius:5px;cursor:pointer;}
hr{margin:30px 0;}
</style>
</head>
<body>
<h2>eCOC Options</h2>

<form method="GET" action="/load">
<label>Load Existing eCOC</label><br>
<input name="reqnum" placeholder="Enter Requisition Number"><br>
<input type="hidden" name="role" value="${escapeHtml(role)}">
<button type="submit">Load Form</button>
</form>

<hr>

<form method="GET" action="/form">
<input type="hidden" name="role" value="${escapeHtml(role)}">
<button type="submit">Start New eCOC</button>
</form>

<p><a href="/view-pdfs">View Generated PDFs</a></p>
</body>
</html>
`);
});

app.get("/load", (req, res) => {
    const { reqnum, role } = req.query;

    if (!reqnum || !role || !["site", "driver", "lab"].includes(role)) {
        return res.send("Invalid requisition number or role");
    }

    db.get("SELECT * FROM coc_forms WHERE requisition_number = ?", [reqnum], (err, row) => {
        if (err) return res.send("DB Error: " + err.message);

        if (!row) {
            if (role === "site") {
                return res.redirect(`/form?role=${role}&newReq=${encodeURIComponent(reqnum)}`);
            }

            return res.send(`No record found for Requisition Number: ${escapeHtml(reqnum)}`);
        }

        res.redirect(`/form/${row.id}?role=${role}`);
    });
});

app.get("/form", (req, res) => {
    const role = req.query.role;
    const newReq = req.query.newReq;

    if (!role || !["site", "driver", "lab"].includes(role)) {
        return res.redirect("/login");
    }

    const form = newReq ? { requisition_number: newReq } : {};
    res.send(renderForm(role, form, [{}]));
});

app.get("/form/:id", (req, res) => {
    const role = req.query.role;
    const id = req.params.id;

    if (!role || !["site", "driver", "lab"].includes(role)) {
        return res.redirect("/login");
    }

    getFormWithRows(id, (err, form, rows) => {
        if (err) return res.send("Record not found");
        res.send(renderForm(role, form, rows));
    });
});

app.post("/add", (req, res) => {
    const d = req.body;
    const role = d.role;

    if (!["site", "driver", "lab"].includes(role)) {
        return res.send("Invalid role");
    }

    const protocol = d.protocol_name === "Other" ? d.protocolOther : d.protocol_name;
    const site = d.site_name === "Other" ? d.siteOther : d.site_name;

    if (d.id) {
        getFormWithRows(d.id, (err, existingForm, existingRows) => {
            if (err) return res.send("Record not found");

            const updatedForm = {
                protocol_name: role === "site" ? protocol : existingForm.protocol_name,
                site_name: role === "site" ? site : existingForm.site_name,
                shipping_date: role === "site" ? d.shipping_date : existingForm.shipping_date,
                courier_name: role === "driver" ? d.courier_name : existingForm.courier_name,
                page_numbers: role === "site" ? d.page_numbers : existingForm.page_numbers,
                shipped_by: role === "site" ? d.shipped_by : existingForm.shipped_by,
                courier_collection_datetime: role === "driver" ? d.courier_collection_datetime : existingForm.courier_collection_datetime,
                delivery_datetime: role === "lab" ? d.delivery_datetime : existingForm.delivery_datetime,
                requisition_number: role === "site" ? d.requisition_number : existingForm.requisition_number,
                pid: role === "site" ? d.pid : existingForm.pid
            };

            db.run(`
                UPDATE coc_forms SET
                    protocol_name=?,
                    site_name=?,
                    shipping_date=?,
                    courier_name=?,
                    page_numbers=?,
                    shipped_by=?,
                    courier_collection_datetime=?,
                    delivery_datetime=?,
                    requisition_number=?,
                    pid=?,
                    updated_at=CURRENT_TIMESTAMP
                WHERE id=?
            `, [
                updatedForm.protocol_name,
                updatedForm.site_name,
                updatedForm.shipping_date,
                updatedForm.courier_name,
                updatedForm.page_numbers,
                updatedForm.shipped_by,
                updatedForm.courier_collection_datetime,
                updatedForm.delivery_datetime,
                updatedForm.requisition_number,
                updatedForm.pid,
                d.id
            ], err => {
                if (err) return res.send("Update Error: " + err.message);

                const mergedRows = mergeRowsForRole(role, d, existingRows);

                saveRowsDirectly(d.id, mergedRows, async saveErr => {
                    if (saveErr) return res.send("Sample Row Error: " + saveErr.message);

                    try {
                        await generatePdf(d.id);
                    } catch (pdfErr) {
                        console.error(pdfErr);
                    }

                    res.redirect(`/form/${d.id}?role=${role}`);
                });
            });
        });
    } else {
        if (role !== "site") {
            return res.send("Only the site role can start a new eCOC.");
        }

        db.run(`
            INSERT INTO coc_forms (
                protocol_name,site_name,shipping_date,courier_name,
                page_numbers,shipped_by,courier_collection_datetime,delivery_datetime,
                requisition_number,pid
            )
            VALUES (?,?,?,?,?,?,?,?,?,?)
        `, [
            protocol,
            site,
            d.shipping_date,
            d.courier_name,
            d.page_numbers,
            d.shipped_by,
            d.courier_collection_datetime,
            d.delivery_datetime,
            d.requisition_number,
            d.pid
        ], function(err) {
            if (err) return res.send("DB Error: " + err.message);

            const formId = this.lastID;

            saveSampleRows(formId, d, async saveErr => {
                if (saveErr) return res.send("Sample Row Error: " + saveErr.message);

                try {
                    await generatePdf(formId);
                } catch (pdfErr) {
                    console.error(pdfErr);
                }

                res.redirect(`/form/${formId}?role=${role}`);
            });
        });
    }
});

app.get("/view-pdfs", (req, res) => {
    const pdfDir = path.join(__dirname, "eCOC IC Labs");

    fs.readdir(pdfDir, (err, files) => {
        if (err) return res.send("Error reading PDF folder.");

        const pdfFiles = files.filter(file => file.endsWith(".pdf"));

        let html = "<h2>All eCOC PDFs</h2><ul>";
        pdfFiles.forEach(file => {
            html += `<li><a href="/pdfs/${encodeURIComponent(file)}" target="_blank">${escapeHtml(file)}</a></li>`;
        });
        html += "</ul>";

        res.send(html);
    });
});

app.get("/download/:id", async (req, res) => {
    const id = req.params.id;

    try {
        await generatePdf(id);
    } catch (err) {
        console.error(err);
    }

    const filePath = path.join(__dirname, "eCOC IC Labs", `eCOC_${id}.pdf`);

    if (fs.existsSync(filePath)) {
        return res.download(filePath, `eCOC_${id}.pdf`);
    }

    res.send("PDF not found.");
});

app.listen(PORT, () => {
    console.log("Server running on port " + PORT);
});