const express = require("express");
const session = require("express-session");
const sqlite3 = require("sqlite3").verbose();
const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");
const bwipjs = require("bwip-js");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));

app.use(session({
    secret: "change-this-to-a-long-random-ic-labs-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        maxAge: 1000 * 60 * 30
    }
}));

app.use(express.static(__dirname));
app.use("/pdfs", express.static(path.join(__dirname, "eCOC IC Labs")));

const users = {
    site: "site123",
    driver: "driver123",
    lab: "lab123",
    owner: "owner123"
};

const roles = ["site", "driver", "lab", "owner"];

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

const shippingTempOptions = [
    "Ambient 15-25",
    "Refrigerated 2-8",
    "Frozen -80",
    "LN2 -196",
    "Other"
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
            site_locked INTEGER DEFAULT 0,
            driver_locked INTEGER DEFAULT 0,
            lab_locked INTEGER DEFAULT 0,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);

    [
        "pid TEXT",
        "delivery_datetime TEXT",
        "site_locked INTEGER DEFAULT 0",
        "driver_locked INTEGER DEFAULT 0",
        "lab_locked INTEGER DEFAULT 0"
    ].forEach(def => {
        const column = def.split(" ")[0];
        db.run(`ALTER TABLE coc_forms ADD COLUMN ${def}`, err => {
            if (err && !err.message.includes("duplicate column name")) {
                console.error(column + " column error:", err.message);
            }
        });
    });

    db.run(`
        CREATE TABLE IF NOT EXISTS coc_sample_rows (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            form_id INTEGER,
            row_order INTEGER,
            sample_type TEXT,
            shipping_temp TEXT,
            shipping_temp_other TEXT,
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

    db.run("ALTER TABLE coc_sample_rows ADD COLUMN shipping_temp_other TEXT", err => {
        if (err && !err.message.includes("duplicate column name")) {
            console.error("shipping_temp_other column error:", err.message);
        }
    });

    db.run(`
        CREATE TABLE IF NOT EXISTS coc_monitors (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            form_id INTEGER,
            row_order INTEGER,
            monitor_sn TEXT,
            FOREIGN KEY(form_id) REFERENCES coc_forms(id)
        )
    `);
});

function requireLogin(req, res, next) {
    if (!req.session || !req.session.role) return res.redirect("/login");
    next();
}

function requireRole(...allowedRoles) {
    return (req, res, next) => {
        if (!req.session || !req.session.role) return res.redirect("/login");
        if (!allowedRoles.includes(req.session.role)) return res.status(403).send("Access denied.");
        next();
    };
}

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
    return currentRole === fieldRole ? "active-required" : "";
}

function requiredAttr(canEdit, label) {
    return canEdit ? `data-required-label="${escapeHtml(label)}"` : "";
}

function renderOptions(options, currentValue) {
    return options.map(option => {
        return `<option value="${escapeHtml(option)}" ${selected(currentValue, option)}>${escapeHtml(option)}</option>`;
    }).join("");
}

function roleInstructions(role, form = {}) {
    if (role === "site" && form.site_locked) return "Your section is locked. Contact the owner if changes are required.";
    if (role === "driver" && form.driver_locked) return "Your section is locked. Contact the owner if changes are required.";
    if (role === "lab" && form.lab_locked) return "Your section is locked. Contact the owner if changes are required.";

    const instructions = {
        site: "Complete protocol, site, shipping date, shipped by, page count, requisition number, PID, sample details, tubes sent, collection date/time and visit.",
        driver: "Complete courier name, courier collection date/time, monitor S/N and pickup temperature.",
        lab: "Complete delivery date/time, tubes received, receiver initial/date, comments and delivery temperature.",
        owner: "Review the eCOC and manage edit access for the site, driver and lab sections."
    };

    return instructions[role] || "";
}

function renderSiteOptions(currentValue, canEdit) {
    return siteOptions.map(site => `
        <label class="choice-line">
            <input type="radio" name="site_name" value="${escapeHtml(site)}" ${checked(currentValue, site)} ${disabled(canEdit)} ${requiredAttr(canEdit, "Site Name")}>
            <span>${escapeHtml(site)}</span>
        </label>
    `).join("");
}

function renderMonitorRows(role, monitors, form = {}) {
    const canEditDriver = role === "driver" && !form.driver_locked;
    const usableMonitors = monitors.length ? monitors : [{}];

    return usableMonitors.map(monitor => `
        <tr class="monitor-row">
            <td class="${activeRoleClass(role, "driver")}">
                <input name="monitor_sn[]" value="${escapeHtml(monitor.monitor_sn)}" ${readonly(canEditDriver)} ${requiredAttr(canEditDriver, "Monitor S/N")}>
            </td>
            ${canEditDriver ? `
                <td class="action-cell">
                    <button type="button" class="small-button danger" onclick="removeMonitorRow(this)">Remove</button>
                </td>
            ` : ""}
        </tr>
    `).join("");
}

function renderSampleRows(role, rows, form = {}) {
    const canEditSite = role === "site" && !form.site_locked;
    const canEditDriver = role === "driver" && !form.driver_locked;
    const canEditLab = role === "lab" && !form.lab_locked;
    const usableRows = rows.length ? rows : [{}];

    return usableRows.map(row => {
        const tempIsOther = row.shipping_temp && !shippingTempOptions.includes(row.shipping_temp);

        return `
            <tr class="sample-row">
                <td class="${activeRoleClass(role, "site")}">
                    <select name="sample_type[]" ${disabled(canEditSite)} ${requiredAttr(canEditSite, "Sample Type")}>
                        ${renderOptions(sampleTypeOptions, row.sample_type)}
                    </select>
                    ${!canEditSite ? `<input type="hidden" name="sample_type[]" value="${escapeHtml(row.sample_type || "")}">` : ""}
                </td>

                <td class="${activeRoleClass(role, "site")}">
                    <select name="shipping_temp[]" onchange="toggleRowOther(this)" ${disabled(canEditSite)} ${requiredAttr(canEditSite, "Shipping Temperature")}>
                        ${renderOptions(shippingTempOptions, tempIsOther ? "Other" : row.shipping_temp)}
                    </select>
                    ${!canEditSite ? `<input type="hidden" name="shipping_temp[]" value="${escapeHtml(row.shipping_temp || "")}">` : ""}
                    <input name="shipping_temp_other[]" class="${tempIsOther ? "" : "hidden"}" value="${tempIsOther ? escapeHtml(row.shipping_temp) : escapeHtml(row.shipping_temp_other)}" placeholder="Enter temp condition">
                </td>

                <td class="${activeRoleClass(role, "site")}"><input type="number" name="tubes_sent[]" value="${escapeHtml(row.tubes_sent)}" ${readonly(canEditSite)} ${requiredAttr(canEditSite, "Tubes Sent")}></td>
                <td class="${activeRoleClass(role, "site")}"><input type="datetime-local" name="sample_collection_datetime[]" value="${escapeHtml(row.sample_collection_datetime)}" ${readonly(canEditSite)} ${requiredAttr(canEditSite, "Sample Collection Date/Time")}></td>
                <td class="${activeRoleClass(role, "site")}"><input name="visit[]" value="${escapeHtml(row.visit)}" ${readonly(canEditSite)} ${requiredAttr(canEditSite, "Visit")}></td>

                <td class="${activeRoleClass(role, "driver")}"><input type="number" step="0.1" name="courier_pickup_temp[]" value="${escapeHtml(row.courier_pickup_temp)}" ${readonly(canEditDriver)} ${requiredAttr(canEditDriver, "Pickup Temperature")}></td>

                <td class="${activeRoleClass(role, "lab")}"><input type="number" name="tubes_received[]" value="${escapeHtml(row.tubes_received)}" ${readonly(canEditLab)} ${requiredAttr(canEditLab, "Tubes Received")}></td>
                <td class="${activeRoleClass(role, "lab")}"><input name="receiver_initial_date[]" value="${escapeHtml(row.receiver_initial_date)}" ${readonly(canEditLab)} ${requiredAttr(canEditLab, "Receiver Initial/Date")}></td>
                <td class="${activeRoleClass(role, "lab")}"><input name="comments[]" value="${escapeHtml(row.comments)}" ${readonly(canEditLab)}></td>
                <td class="${activeRoleClass(role, "lab")}"><input type="number" step="0.1" name="delivery_temp[]" value="${escapeHtml(row.delivery_temp)}" ${readonly(canEditLab)} ${requiredAttr(canEditLab, "Delivery Temperature")}></td>

                ${canEditSite ? `
                    <td class="action-cell">
                        <button type="button" class="small-button danger" onclick="removeSampleRow(this)">Remove</button>
                    </td>
                ` : ""}
            </tr>
        `;
    }).join("");
}

function renderForm(role, form = {}, rows = [], monitors = []) {
    const canEditSite = role === "site" && !form.site_locked;
    const canEditDriver = role === "driver" && !form.driver_locked;
    const canEditLab = role === "lab" && !form.lab_locked;
    const isOwner = role === "owner";

    const protocolIsOther = form.protocol_name && !protocolOptions.includes(form.protocol_name);
    const siteIsOther = form.site_name && !siteOptions.includes(form.site_name);

    return `
<html>
<head>
<title>IC Labs eCOC</title>
<style>
body{font-family:Arial,sans-serif;margin:0;padding:10px;background:#dfe4ea;color:#1f2933;}
.form-shell{width:1120px;min-height:790px;margin:auto;background:white;padding:16px;border-radius:0;box-shadow:0 4px 10px rgba(0,0,0,.12);box-sizing:border-box;}
.header{display:grid;grid-template-columns:220px 1fr 300px;align-items:start;gap:12px;margin-bottom:10px;}
.logo{width:135px;}
.title{text-align:center;font-size:20px;font-weight:bold;padding-top:18px;}
.contact{font-size:11px;line-height:1.3;text-align:right;}
table{width:100%;border-collapse:collapse;margin-top:8px;table-layout:fixed;}
th,td{border:1px solid #9aa6b2;padding:4px;vertical-align:top;}
th{background:#e8eef5;font-size:10px;text-align:center;}
label{font-weight:bold;display:block;margin-bottom:3px;font-size:11px;}
input,select,textarea{width:100%;box-sizing:border-box;padding:4px;border:1px solid #b7c0ca;border-radius:3px;font-size:11px;}
input[readonly]{background:#f1f3f5;}
.active-required{
    background:#fffafa;
}
.role-key{display:flex;gap:10px;margin:8px 0;font-size:11px;align-items:center;}
.role-key span{display:inline-flex;align-items:center;gap:4px;}
.role-dot{width:12px;height:12px;border:1px solid #c0392b;display:inline-block;background:#fff5f5;}
.instruction-box{margin:8px 0;padding:8px 10px;background:#f5f7fa;border-left:4px solid #1f3a5f;font-size:12px;}
.owner-box{margin:8px 0;padding:8px 10px;background:#eef4fb;border:1px solid #c9d8e8;font-size:12px;display:flex;justify-content:space-between;align-items:center;}
.owner-box a{background:#1f3a5f;color:white;text-decoration:none;padding:7px 10px;border-radius:4px;}
.choice-group{border:1px solid #b7c0ca;border-radius:3px;padding:4px;background:#fff;font-size:10px;}
.choice-line{font-weight:normal;display:flex;gap:5px;align-items:flex-start;margin:3px 0;}
.choice-line input{width:auto;margin-top:1px;}
.note-cell{font-weight:bold;line-height:1.3;background:#fff7e6;font-size:11px;}
.main-grid{display:grid;grid-template-columns:150px 1fr;gap:8px;align-items:start;}
.requisition-box{min-height:150px;}
.monitor-table th,.monitor-table td{font-size:10px;}
.table-scroll{overflow:visible;}
.sample-table{table-layout:fixed;}
.sample-table th{font-size:9px;line-height:1.1;}
.sample-table td{padding:3px;}
.sample-table input,.sample-table select{min-width:0;font-size:10px;padding:3px;}
.sample-table th:nth-child(1){width:90px;}
.sample-table th:nth-child(2){width:70px;}
.sample-table th:nth-child(3){width:50px;}
.sample-table th:nth-child(4){width:95px;}
.sample-table th:nth-child(5){width:45px;}
.sample-table th:nth-child(6){width:60px;}
.sample-table th:nth-child(7){width:50px;}
.sample-table th:nth-child(8){width:82px;}
.sample-table th:nth-child(9){width:80px;}
.sample-table th:nth-child(10){width:55px;}
.sample-table th:nth-child(11){width:55px;}
.action-cell{width:55px;text-align:center;}
.button-row{display:flex;gap:10px;margin-top:12px;}
button,.button-link{padding:8px 12px;background:#2c3e50;color:white;border:none;border-radius:4px;cursor:pointer;text-decoration:none;text-align:center;font-size:13px;}
button.primary{flex:1;}
.small-button{padding:5px 6px;font-size:10px;}
.danger{background:#b42318;}
.success{background:#218838;}
.hidden{display:none;}
.missing-field,.required-empty{border:2px solid #c0392b!important;background:#ffecec!important;}
.required-cell{
    box-shadow:none;
}
.lock-badge{font-weight:bold;color:#7a4b00;}
@page{size:A4 landscape;margin:8mm;}
@media print{body{background:white;padding:0;}.form-shell{width:100%;min-height:auto;box-shadow:none;padding:0;}.button-row,.role-key,.instruction-box,.owner-box{display:none;}}
</style>
</head>
<body>
<div class="form-shell">
<form method="POST" action="/add" onsubmit="return validateBeforeSave()">
<input type="hidden" name="id" value="${escapeHtml(form.id)}">

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
    <span><i class="role-dot"></i> Your required section ${form[role + "_locked"] ? "<span class='lock-badge'>(locked)</span>" : ""}</span>
</div>

<div class="instruction-box">
    <strong>Your section:</strong> ${escapeHtml(roleInstructions(role, form))}
</div>

${isOwner && form.id ? `
<div class="owner-box">
    <span>Owner access: manage which sections can be edited again.</span>
    <a href="/owner/${form.id}">Manage Access</a>
</div>
` : ""}

<table>
    <tr>
        <td class="${activeRoleClass(role, "site")}">
            <label>Protocol Name</label>
            <select name="protocol_name" onchange="toggleOther(this,'protocolOther')" ${disabled(canEditSite)} ${requiredAttr(canEditSite, "Protocol Name")}>
                ${renderOptions(protocolOptions, protocolIsOther ? "Other" : form.protocol_name)}
            </select>
            ${!canEditSite ? `<input type="hidden" name="protocol_name" value="${escapeHtml(form.protocol_name || "")}">` : ""}
            <input id="protocolOther" name="protocolOther" class="${protocolIsOther ? "" : "hidden"}" value="${protocolIsOther ? escapeHtml(form.protocol_name) : ""}" placeholder="Enter protocol">
        </td>

        <td class="${activeRoleClass(role, "site")}">
            <label>Shipping Date</label>
            <input type="date" name="shipping_date" value="${escapeHtml(form.shipping_date || todayDate())}" ${readonly(canEditSite)} ${requiredAttr(canEditSite, "Shipping Date")}>
        </td>

        <td class="${activeRoleClass(role, "driver")}">
            <label>Courier Name</label>
            <input name="courier_name" value="${escapeHtml(form.courier_name)}" ${readonly(canEditDriver)} ${requiredAttr(canEditDriver, "Courier Name")}>
        </td>

        <td class="${activeRoleClass(role, "site")}">
            <label>Number of Pages</label>
            <input type="number" name="page_numbers" value="${escapeHtml(form.page_numbers)}" ${readonly(canEditSite)} ${requiredAttr(canEditSite, "Number of Pages")}>
        </td>
    </tr>

    <tr>
        <td class="${activeRoleClass(role, "site")}">
            <label>Site Name</label>
            <div class="choice-group">
                ${renderSiteOptions(siteIsOther ? "Other" : form.site_name, canEditSite)}
            </div>
            ${!canEditSite ? `<input type="hidden" name="site_name" value="${escapeHtml(form.site_name || "")}">` : ""}
            <input id="siteOther" name="siteOther" class="${siteIsOther ? "" : "hidden"}" value="${siteIsOther ? escapeHtml(form.site_name) : ""}" placeholder="Enter site">
        </td>

        <td class="${activeRoleClass(role, "site")}">
            <label>Shipped By</label>
            <input name="shipped_by" value="${escapeHtml(form.shipped_by)}" ${readonly(canEditSite)} placeholder="Name and surname" ${requiredAttr(canEditSite, "Shipped By")}>
        </td>

        <td class="${activeRoleClass(role, "driver")}">
            <label>Courier Collection Date & Time</label>
            <input type="datetime-local" name="courier_collection_datetime" value="${escapeHtml(form.courier_collection_datetime)}" ${readonly(canEditDriver)} ${requiredAttr(canEditDriver, "Courier Collection Date & Time")}>
        </td>

        <td class="${activeRoleClass(role, "lab")}">
            <label>Delivery Date & Time</label>
            <input type="datetime-local" name="delivery_datetime" value="${escapeHtml(form.delivery_datetime)}" ${readonly(canEditLab)} ${requiredAttr(canEditLab, "Delivery Date & Time")}>
        </td>
    </tr>

    <tr>
        <td colspan="4" class="note-cell">Note: This log must physically accompany the samples.</td>
    </tr>
</table>

<div class="main-grid">
    <div>
        <table class="requisition-box ${activeRoleClass(role, "site")}">
            <tr><th>Requisition Number</th></tr>
            <tr><td><input name="requisition_number" value="${escapeHtml(form.requisition_number)}" ${readonly(canEditSite)} ${requiredAttr(canEditSite, "Requisition Number")}></td></tr>
            <tr><th>PID Number</th></tr>
            <tr><td><input name="pid" value="${escapeHtml(form.pid)}" ${readonly(canEditSite)} ${requiredAttr(canEditSite, "PID Number")}></td></tr>
        </table>

        <table class="monitor-table">
            <thead>
                <tr>
                    <th class="${activeRoleClass(role, "driver")}">Monitor S/N</th>
                    ${canEditDriver ? `<th>Action</th>` : ""}
                </tr>
            </thead>
            <tbody id="monitorRows">
                ${renderMonitorRows(role, monitors, form)}
            </tbody>
        </table>

        ${canEditDriver ? `<button type="button" class="small-button" style="margin-top:6px;width:100%;" onclick="addMonitorRow()">Add Monitor</button>` : ""}
    </div>

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
                    ${canEditSite ? `<th>Action</th>` : ""}
                </tr>
            </thead>
            <tbody id="sampleRows">
                ${renderSampleRows(role, rows, form)}
            </tbody>
        </table>
    </div>
</div>

<div class="button-row">
    ${canEditSite ? `<button type="button" onclick="addSampleRow()">Add Sample Type</button>` : ""}
    ${role !== "owner" ? `<button class="primary" type="submit">Save eCOC</button>` : ""}
    ${form.id ? `<a class="button-link success" href="/download/${form.id}">Download PDF</a>` : ""}
    <a class="button-link" href="/logout">Log Out</a>
</div>

</form>
</div>

<script>
function toggleOther(select, inputId){
    const input = document.getElementById(inputId);
    if(!input) return;

    if(select.value === "Other"){
        input.classList.remove("hidden");
        input.setAttribute("data-required-label", input.placeholder || "Other field");
    } else {
        input.classList.add("hidden");
        input.removeAttribute("data-required-label");
        input.value = "";
    }

    refreshRequiredHighlights();
}

function toggleRowOther(select){
    const input = select.parentElement.querySelector('input[name="shipping_temp_other[]"]');
    if(!input) return;

    if(select.value === "Other"){
        input.classList.remove("hidden");
        input.setAttribute("data-required-label", "Other Shipping Temperature");
    } else {
        input.classList.add("hidden");
        input.removeAttribute("data-required-label");
        input.value = "";
    }

    refreshRequiredHighlights();
}

document.querySelectorAll('input[name="site_name"]').forEach(input => {
    input.addEventListener("change", () => {
        const other = document.getElementById("siteOther");
        if(!other) return;

        if(input.value === "Other" && input.checked){
            other.classList.remove("hidden");
            other.setAttribute("data-required-label", "Other Site Name");
        } else if(input.checked) {
            other.classList.add("hidden");
            other.removeAttribute("data-required-label");
            other.value = "";
        }

        refreshRequiredHighlights();
    });
});

function addSampleRow(){
    const tbody = document.getElementById("sampleRows");
    const tr = document.createElement("tr");
    tr.className = "sample-row";

    tr.innerHTML = \`
        <td class="${activeRoleClass(role, "site")}">
            <select name="sample_type[]" data-required-label="Sample Type">
                <option value="4ml EDTA">4ml EDTA</option>
                <option value="6ml EDTA">6ml EDTA</option>
                <option value="4ml SST">4ml SST</option>
                <option value="Urine">Urine</option>
                <option value="PK Plasma Aliquots">PK Plasma Aliquots</option>
                <option value="Spot Sputum">Spot Sputum</option>
            </select>
        </td>
        <td class="${activeRoleClass(role, "site")}">
            <select name="shipping_temp[]" onchange="toggleRowOther(this)" data-required-label="Shipping Temperature">
                <option value="Ambient 15-25">Ambient 15-25</option>
                <option value="Refrigerated 2-8">Refrigerated 2-8</option>
                <option value="Frozen -80">Frozen -80</option>
                <option value="LN2 -196">LN2 -196</option>
                <option value="Other">Other</option>
            </select>
            <input name="shipping_temp_other[]" class="hidden" placeholder="Enter temp condition">
        </td>
        <td class="${activeRoleClass(role, "site")}"><input type="number" name="tubes_sent[]" data-required-label="Tubes Sent"></td>
        <td class="${activeRoleClass(role, "site")}"><input type="datetime-local" name="sample_collection_datetime[]" data-required-label="Sample Collection Date/Time"></td>
        <td class="${activeRoleClass(role, "site")}"><input name="visit[]" data-required-label="Visit"></td>
        <td class="${activeRoleClass(role, "driver")}"><input type="number" step="0.1" name="courier_pickup_temp[]" readonly></td>
        <td class="${activeRoleClass(role, "lab")}"><input type="number" name="tubes_received[]" readonly></td>
        <td class="${activeRoleClass(role, "lab")}"><input name="receiver_initial_date[]" readonly></td>
        <td class="${activeRoleClass(role, "lab")}"><input name="comments[]" readonly></td>
        <td class="${activeRoleClass(role, "lab")}"><input type="number" step="0.1" name="delivery_temp[]" readonly></td>
        <td class="action-cell"><button type="button" class="small-button danger" onclick="removeSampleRow(this)">Remove</button></td>
    \`;

    tbody.appendChild(tr);
    refreshRequiredHighlights();
}

function removeSampleRow(button){
    const rows = document.querySelectorAll(".sample-row");
    if(rows.length <= 1) return;
    button.closest("tr").remove();
    refreshRequiredHighlights();
}

function addMonitorRow(){
    const tbody = document.getElementById("monitorRows");
    const tr = document.createElement("tr");
    tr.className = "monitor-row";

    tr.innerHTML = \`
        <td class="${activeRoleClass(role, "driver")}">
            <input name="monitor_sn[]" data-required-label="Monitor S/N">
        </td>
        <td class="action-cell">
            <button type="button" class="small-button danger" onclick="removeMonitorRow(this)">Remove</button>
        </td>
    \`;

    tbody.appendChild(tr);
    refreshRequiredHighlights();
}

function removeMonitorRow(button){
    const rows = document.querySelectorAll(".monitor-row");
    if(rows.length <= 1) return;
    button.closest("tr").remove();
    refreshRequiredHighlights();
}

function refreshRequiredHighlights(){
    document.querySelectorAll(".required-empty").forEach(el => el.classList.remove("required-empty"));
    document.querySelectorAll(".required-cell").forEach(el => el.classList.remove("required-cell"));

    const fields = Array.from(document.querySelectorAll("[data-required-label]"))
        .filter(field => !field.disabled && !field.readOnly && !field.classList.contains("hidden"));

    fields.forEach(field => {
        const type = field.getAttribute("type");
        let empty = false;

        if(type === "radio"){
            const group = document.querySelectorAll('input[name="' + field.name + '"]');
            empty = !Array.from(group).some(radio => radio.checked);

            if(empty){
                const groupBox = field.closest(".choice-group");
                if(groupBox) groupBox.classList.add("required-empty");
            }
        } else {
            empty = !String(field.value || "").trim();

            if(empty){
                field.classList.add("required-empty");
            }
        }

        if(empty){
            const cell = field.closest("td");
            if(cell) cell.classList.add("required-cell");
        }
    });
}

function validateBeforeSave(){
    refreshRequiredHighlights();

    const fields = Array.from(document.querySelectorAll("[data-required-label]"))
        .filter(field => !field.disabled && !field.readOnly && !field.classList.contains("hidden"));

    const missing = [];

    fields.forEach(field => {
        const type = field.getAttribute("type");
        let empty = false;

        if(type === "radio"){
            const group = document.querySelectorAll('input[name="' + field.name + '"]');
            empty = !Array.from(group).some(radio => radio.checked);
        } else {
            empty = !String(field.value || "").trim();
        }

        if(empty){
            const label = field.getAttribute("data-required-label");
            if(!missing.includes(label)) missing.push(label);
        }
    });

    if(missing.length === 0) return true;

    const message =
        "The following field(s) have not been completed:\\n\\n" +
        missing.map(item => "- " + item).join("\\n") +
        "\\n\\nIf something should be blank, click OK to save anyway.\\nClick Cancel to go back and complete the form.";

    return confirm(message);
}

document.addEventListener("input", refreshRequiredHighlights);
document.addEventListener("change", refreshRequiredHighlights);
document.addEventListener("DOMContentLoaded", refreshRequiredHighlights);
</script>
</body>
</html>
`;
}

function getFormWithRows(id, callback) {
    db.get("SELECT * FROM coc_forms WHERE id = ?", [id], (err, form) => {
        if (err || !form) return callback(err || new Error("Record not found"));

        db.all("SELECT * FROM coc_sample_rows WHERE form_id = ? ORDER BY row_order, id", [id], (rowErr, rows) => {
            if (rowErr) return callback(rowErr);

            db.all("SELECT * FROM coc_monitors WHERE form_id = ? ORDER BY row_order, id", [id], (monitorErr, monitors) => {
                if (monitorErr) return callback(monitorErr);
                callback(null, form, rows, monitors);
            });
        });
    });
}

function saveSampleRows(formId, d, callback) {
    const sampleTypes = normalizeArray(d.sample_type);
    const shippingTemps = normalizeArray(d.shipping_temp);
    const shippingTempOthers = normalizeArray(d.shipping_temp_other);
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
                form_id,row_order,sample_type,shipping_temp,shipping_temp_other,tubes_sent,
                sample_collection_datetime,visit,courier_pickup_temp,
                tubes_received,receiver_initial_date,comments,delivery_temp
            )
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        `);

        for (let i = 0; i < sampleTypes.length; i++) {
            const temp = shippingTemps[i] === "Other" ? shippingTempOthers[i] : shippingTemps[i];

            stmt.run([
                formId,
                i,
                sampleTypes[i],
                temp,
                shippingTempOthers[i],
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

function saveMonitors(formId, d, callback) {
    const monitorSns = normalizeArray(d.monitor_sn);

    db.run("DELETE FROM coc_monitors WHERE form_id = ?", [formId], err => {
        if (err) return callback(err);

        const stmt = db.prepare("INSERT INTO coc_monitors (form_id,row_order,monitor_sn) VALUES (?,?,?)");

        monitorSns.forEach((monitorSn, index) => {
            if (String(monitorSn || "").trim()) {
                stmt.run([formId, index, monitorSn]);
            }
        });

        stmt.finalize(callback);
    });
}

function saveRowsDirectly(formId, rows, callback) {
    db.run("DELETE FROM coc_sample_rows WHERE form_id = ?", [formId], err => {
        if (err) return callback(err);

        const stmt = db.prepare(`
            INSERT INTO coc_sample_rows (
                form_id,row_order,sample_type,shipping_temp,shipping_temp_other,tubes_sent,
                sample_collection_datetime,visit,courier_pickup_temp,
                tubes_received,receiver_initial_date,comments,delivery_temp
            )
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        `);

        rows.forEach((row, index) => {
            stmt.run([
                formId,
                index,
                row.sample_type,
                row.shipping_temp,
                row.shipping_temp_other,
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
    const shippingTempOthers = normalizeArray(d.shipping_temp_other);
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
        const temp = shippingTemps[i] === "Other" ? shippingTempOthers[i] : shippingTemps[i];

        rows.push({
            sample_type: role === "site" ? sampleTypes[i] : old.sample_type,
            shipping_temp: role === "site" ? temp : old.shipping_temp,
            shipping_temp_other: role === "site" ? shippingTempOthers[i] : old.shipping_temp_other,
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

function lockRoleSection(formId, role, callback) {
    const lockMap = {
        site: "site_locked",
        driver: "driver_locked",
        lab: "lab_locked"
    };

    const column = lockMap[role];
    if (!column) return callback();

    db.run(`UPDATE coc_forms SET ${column}=1 WHERE id=?`, [formId], callback);
}

async function generatePdf(formId) {
    return new Promise((resolve, reject) => {
        getFormWithRows(formId, async (err, form, rows, monitors) => {
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
                doc.rect(x, y, w, h).fillAndStroke(options.fill || "#ffffff", border);
                doc.fillColor(navy).font("Helvetica-Bold").fontSize(6.5).text(label, x + 4, y + 4, { width: w - 8 });
                doc.fillColor(text).font("Helvetica").fontSize(options.valueSize || 7.5).text(value || "-", x + 4, y + 16, { width: w - 8, height: h - 18 });
            }

            function tableHeader(x, y, widths, headers) {
                let cx = x;
                doc.font("Helvetica-Bold").fontSize(5.6);
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
                doc.image(logoPath, 26, 8, { width: 72 });
            }

            doc.fillColor(navy).font("Helvetica-Bold").fontSize(17).text("Electronic Chain of Custody Form", 0, 26, { align: "center" });

            doc.fillColor(text).font("Helvetica").fontSize(7).text(
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

            doc.fillColor(navy).font("Helvetica-Bold").fontSize(8).text(`Document Ref: ${docRefNum}`, 24, 86);

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
            cell(24, reqY, 132, 34, "Requisition Number", form.requisition_number, { fill: paleBlue, valueSize: 8.5 });
            cell(24, reqY + 34, 132, 34, "PID Number", form.pid, { fill: paleBlue, valueSize: 8.5 });

            const monitorText = monitors.length ? monitors.map(m => m.monitor_sn).join("\n") : "-";
            cell(24, reqY + 68, 132, 64, "Monitor S/N", monitorText, { fill: "#ffffff", valueSize: 7 });

            const tableX = 166;
            let tableY = reqY;
            const headers = ["Sample Type", "Ship Temp", "Tubes Sent", "Collection Date/Time", "Visit", "Pickup Temp", "Tubes Rec.", "Receiver Initial/Date", "Comments", "Delivery Temp"];
            const widths = [82, 68, 48, 92, 40, 56, 48, 82, 86, 50];

            tableHeader(tableX, tableY, widths, headers);
            tableY += 24;

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
                    doc.fillColor(text).font("Helvetica").fontSize(5.6).text(value || "-", x + 2, tableY + 5, { width: widths[i] - 4, height: rowH - 8 });
                    x += widths[i];
                });

                tableY += rowH;
            });

            const footerY = 560;
            doc.moveTo(24, footerY).lineTo(doc.page.width - 24, footerY).strokeColor(border).stroke();
            doc.fillColor("#5b6775").font("Helvetica").fontSize(6.5).text(
                "Generated electronically by IC Labs eCOC system. Review all entered details before releasing samples.",
                24,
                footerY + 8,
                { width: doc.page.width - 48, align: "center" }
            );

            doc.end();

            stream.on("finish", resolve);
            stream.on("error", reject);
        });
    });
}

function renderAuthCard(title, bodyHtml) {
    return `
<html>
<head>
<title>${escapeHtml(title)}</title>
<style>
body{font-family:Arial,sans-serif;margin:0;min-height:100vh;background:linear-gradient(135deg,#eef4f8,#d9e4ec);display:flex;align-items:center;justify-content:center;color:#1f2933;}
.card{width:390px;background:white;padding:34px;border-radius:10px;box-shadow:0 12px 30px rgba(31,58,95,.18);text-align:center;}
.logo{width:150px;margin-bottom:12px;}
h1{font-size:22px;margin:8px 0 4px;color:#1f3a5f;}
p{margin:0 0 24px;font-size:13px;color:#5b6775;}
label{display:block;text-align:left;font-size:13px;font-weight:bold;margin:12px 0 5px;}
input,select{width:100%;box-sizing:border-box;padding:10px;border:1px solid #b7c0ca;border-radius:5px;font-size:14px;}
button,.link-button{display:block;box-sizing:border-box;width:100%;margin-top:14px;padding:11px;background:#1f3a5f;color:white;border:none;border-radius:5px;cursor:pointer;font-size:15px;font-weight:bold;text-decoration:none;}
.secondary{background:#eef4fb;color:#1f3a5f;border:1px solid #c9d8e8;}
hr{border:none;border-top:1px solid #e1e7ef;margin:24px 0;}
</style>
</head>
<body>
<div class="card">
<img src="/IC_Labs_Logo.png" class="logo">
${bodyHtml}
</div>
</body>
</html>
`;
}

app.get("/", (req, res) => res.redirect("/login"));

app.get("/login", (req, res) => {
    res.send(renderAuthCard("IC Labs eCOC Login", `
        <h1>IC Labs eCOC Login</h1>
        <p>Electronic Chain of Custody Access</p>
        <form method="POST" action="/login">
            <label>Role</label>
            <select name="role">
                <option value="site">Site</option>
                <option value="driver">Driver</option>
                <option value="lab">Lab</option>
                <option value="owner">Owner</option>
            </select>
            <label>Password</label>
            <input type="password" name="password">
            <button type="submit">Sign In</button>
        </form>
    `));
});

app.post("/login", (req, res) => {
    const { role, password } = req.body;

    if (users[role] && password === users[role]) {
        req.session.role = role;
        return res.redirect("/search");
    }

    res.send(renderAuthCard("Login Failed", `
        <h1>Login Failed</h1>
        <p>Invalid role or password.</p>
        <a class="link-button" href="/login">Try Again</a>
    `));
});

app.get("/logout", (req, res) => {
    req.session.destroy(() => {
        res.redirect("/login");
    });
});

app.get("/search", requireLogin, (req, res) => {
    const role = req.session.role;

    res.send(renderAuthCard("eCOC Options", `
        <h1>eCOC Options</h1>
        <p>${escapeHtml(role.toUpperCase())} access</p>

        <form method="GET" action="/load">
            <label>Load Existing eCOC</label>
            <input name="reqnum" placeholder="Enter Requisition Number">
            <button type="submit">Load Form</button>
        </form>

        ${role === "site" ? `
            <hr>
            <form method="GET" action="/form">
                <button type="submit">Start New eCOC</button>
            </form>
        ` : ""}

        <a class="link-button secondary" href="/view-pdfs">View Generated PDFs</a>
        <a class="link-button secondary" href="/logout">Log Out</a>
    `));
});

app.get("/load", requireLogin, (req, res) => {
    const { reqnum } = req.query;
    const role = req.session.role;

    if (!reqnum) return res.send("Invalid requisition number");

    db.get("SELECT * FROM coc_forms WHERE requisition_number = ?", [reqnum], (err, row) => {
        if (err) return res.send("DB Error: " + err.message);

        if (!row) {
            if (role === "site") return res.redirect(`/form?newReq=${encodeURIComponent(reqnum)}`);
            return res.send(`No record found for Requisition Number: ${escapeHtml(reqnum)}`);
        }

        res.redirect(`/form/${row.id}`);
    });
});

app.get("/form", requireRole("site"), (req, res) => {
    const role = req.session.role;
    const newReq = req.query.newReq;
    const form = newReq ? { requisition_number: newReq, site_locked: 0, driver_locked: 0, lab_locked: 0 } : { site_locked: 0, driver_locked: 0, lab_locked: 0 };

    res.send(renderForm(role, form, [{}], [{}]));
});

app.get("/form/:id", requireLogin, (req, res) => {
    const role = req.session.role;
    const id = req.params.id;

    getFormWithRows(id, (err, form, rows, monitors) => {
        if (err) return res.send("Record not found");
        res.send(renderForm(role, form, rows, monitors));
    });
});

app.post("/add", requireRole("site", "driver", "lab"), (req, res) => {
    const d = req.body;
    const role = req.session.role;

    const protocol = d.protocol_name === "Other" ? d.protocolOther : d.protocol_name;
    const site = d.site_name === "Other" ? d.siteOther : d.site_name;

    if (d.id) {
        getFormWithRows(d.id, (err, existingForm, existingRows) => {
            if (err) return res.send("Record not found");

            if ((role === "site" && existingForm.site_locked) ||
                (role === "driver" && existingForm.driver_locked) ||
                (role === "lab" && existingForm.lab_locked)) {
                return res.send("This section is locked. Please contact the owner to allow edits.");
            }

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

                saveRowsDirectly(d.id, mergedRows, rowErr => {
                    if (rowErr) return res.send("Sample Row Error: " + rowErr.message);

                    const afterMonitor = () => {
                        lockRoleSection(d.id, role, async lockErr => {
                            if (lockErr) return res.send("Lock Error: " + lockErr.message);

                            try {
                                await generatePdf(d.id);
                            } catch (pdfErr) {
                                console.error(pdfErr);
                            }

                            res.redirect(`/form/${d.id}`);
                        });
                    };

                    if (role === "driver") {
                        saveMonitors(d.id, d, monitorErr => {
                            if (monitorErr) return res.send("Monitor Error: " + monitorErr.message);
                            afterMonitor();
                        });
                    } else {
                        afterMonitor();
                    }
                });
            });
        });
    } else {
        if (role !== "site") return res.send("Only the site role can start a new eCOC.");

        db.run(`
            INSERT INTO coc_forms (
                protocol_name,site_name,shipping_date,courier_name,
                page_numbers,shipped_by,courier_collection_datetime,delivery_datetime,
                requisition_number,pid,site_locked,driver_locked,lab_locked
            )
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
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
            d.pid,
            1,
            0,
            0
        ], function(err) {
            if (err) return res.send("DB Error: " + err.message);

            const formId = this.lastID;

            saveSampleRows(formId, d, async sampleErr => {
                if (sampleErr) return res.send("Sample Row Error: " + sampleErr.message);

                try {
                    await generatePdf(formId);
                } catch (pdfErr) {
                    console.error(pdfErr);
                }

                res.redirect(`/form/${formId}`);
            });
        });
    }
});

app.get("/owner/:id", requireRole("owner"), (req, res) => {
    const id = req.params.id;

    db.get("SELECT * FROM coc_forms WHERE id = ?", [id], (err, form) => {
        if (err || !form) return res.send("Record not found");

        res.send(renderAuthCard("Owner Access Control", `
            <h1>Owner Access Control</h1>
            <p>Requisition: ${escapeHtml(form.requisition_number || "-")}</p>

            <form method="POST" action="/owner/${id}/access">
                <label><input type="checkbox" name="allow_site" ${form.site_locked ? "" : "checked"} style="width:auto;"> Allow Site to edit</label>
                <label><input type="checkbox" name="allow_driver" ${form.driver_locked ? "" : "checked"} style="width:auto;"> Allow Driver to edit</label>
                <label><input type="checkbox" name="allow_lab" ${form.lab_locked ? "" : "checked"} style="width:auto;"> Allow Lab to edit</label>

                <button type="submit">Update Access</button>
            </form>

            <a class="link-button secondary" href="/form/${id}">Back to Form</a>
        `));
    });
});

app.post("/owner/:id/access", requireRole("owner"), (req, res) => {
    const id = req.params.id;
    const d = req.body;

    db.run(`
        UPDATE coc_forms SET
            site_locked=?,
            driver_locked=?,
            lab_locked=?,
            updated_at=CURRENT_TIMESTAMP
        WHERE id=?
    `, [
        d.allow_site ? 0 : 1,
        d.allow_driver ? 0 : 1,
        d.allow_lab ? 0 : 1,
        id
    ], err => {
        if (err) return res.send("Access update error: " + err.message);
        res.redirect(`/form/${id}`);
    });
});

app.get("/view-pdfs", requireLogin, (req, res) => {
    const pdfDir = path.join(__dirname, "eCOC IC Labs");

    fs.readdir(pdfDir, (err, files) => {
        if (err) return res.send("Error reading PDF folder.");

        const pdfFiles = files.filter(file => file.endsWith(".pdf"));

        let html = "<h2>All eCOC PDFs</h2><ul>";
        pdfFiles.forEach(file => {
            html += `<li><a href="/pdfs/${encodeURIComponent(file)}" target="_blank">${escapeHtml(file)}</a></li>`;
        });
        html += "</ul><p><a href='/search'>Back</a></p>";

        res.send(html);
    });
});

app.get("/download/:id", requireLogin, async (req, res) => {
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