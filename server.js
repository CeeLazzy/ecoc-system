const express = require("express");
const session = require("express-session");
const { Pool } = require("pg");
const PDFDocument = require("pdfkit");
const QRCode = require("qrcode");
const bwipjs = require("bwip-js");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));

app.use(session({
    secret: process.env.SESSION_SECRET || "change-this-session-secret",
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, maxAge: 1000 * 60 * 30 }
}));

app.use(express.static(__dirname));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes("localhost")
        ? { rejectUnauthorized: false }
        : false
});

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

async function initDb() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS coc_forms (
            id SERIAL PRIMARY KEY,
            protocol_name TEXT,
            site_name TEXT,
            shipping_date DATE,
            courier_name TEXT,
            page_numbers TEXT,
            shipped_by TEXT,
            courier_collection_datetime TIMESTAMP,
            delivery_datetime TIMESTAMP,
            requisition_number TEXT UNIQUE,
            pid TEXT,
            site_locked BOOLEAN DEFAULT FALSE,
            driver_locked BOOLEAN DEFAULT FALSE,
            lab_locked BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS coc_sample_rows (
            id SERIAL PRIMARY KEY,
            form_id INTEGER REFERENCES coc_forms(id) ON DELETE CASCADE,
            row_order INTEGER,
            sample_type TEXT,
            shipping_temp TEXT,
            shipping_temp_other TEXT,
            tubes_sent INTEGER,
            sample_collection_datetime TIMESTAMP,
            visit TEXT,
            courier_pickup_temp REAL,
            tubes_received INTEGER,
            receiver_initial_date TEXT,
            comments TEXT,
            delivery_temp REAL
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS coc_monitors (
            id SERIAL PRIMARY KEY,
            form_id INTEGER REFERENCES coc_forms(id) ON DELETE CASCADE,
            row_order INTEGER,
            monitor_sn TEXT
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS coc_job_numbers (
            id SERIAL PRIMARY KEY,
            form_id INTEGER REFERENCES coc_forms(id) ON DELETE CASCADE,
            row_order INTEGER,
            job_number TEXT
        )
    `);
}

initDb().catch(err => {
    console.error("Database init failed:", err);
    process.exit(1);
});

function requireLogin(req, res, next) {
    if (!req.session || !req.session.role) {
        if (req.session) req.session.returnTo = req.originalUrl;
        return res.redirect("/login");
    }
    next();
}

function requireRole(...allowedRoles) {
    return (req, res, next) => {
        if (!req.session || !req.session.role) {
            if (req.session) req.session.returnTo = req.originalUrl;
            return res.redirect("/login");
        }
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

function dateOnly(value) {
    if (!value) return "";
    if (value instanceof Date) return value.toISOString().split("T")[0];
    return String(value).split("T")[0].split(" ")[0];
}

function dateTimeInput(value) {
    if (!value) return "";
    const d = value instanceof Date ? value : new Date(value);
    if (isNaN(d)) return "";
    const pad = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDateTime(value) {
    if (!value) return "";
    if (value instanceof Date) return value.toISOString().replace("T", " ").slice(0, 16);
    return String(value).replace("T", " ").slice(0, 16);
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

function requiredAttr(canEdit, label) {
    return canEdit ? `data-required-label="${escapeHtml(label)}"` : "";
}

function renderOptions(options, currentValue) {
    return options.map(option =>
        `<option value="${escapeHtml(option)}" ${selected(currentValue, option)}>${escapeHtml(option)}</option>`
    ).join("");
}

function siteSlug(siteName) {
    return String(siteName || "unknown-site")
        .replace(/[^a-zA-Z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .toLowerCase();
}

function roleInstructions(role, form = {}) {
    if (role === "site" && form.site_locked) return "Your section is locked. Contact the owner if changes are required.";
    if (role === "driver" && form.driver_locked) return "Your section is locked. Contact the owner if changes are required.";
    if (role === "lab" && form.lab_locked) return "Your section is locked. Contact the owner if changes are required.";

    return {
        site: "Complete protocol, site, shipping date, shipped by, page count, requisition number, PID, sample details, tubes sent, collection date/time and visit.",
        driver: "Complete courier name, courier collection date/time, monitor S/N, job number and pickup temperature.",
        lab: "Complete delivery date/time, tubes received, receiver initial/date, comments and delivery temperature.",
        owner: "Review the eCOC and manage edit access for the site, driver and lab sections."
    }[role] || "";
}

async function getFormBundle(id) {
    const formResult = await pool.query("SELECT * FROM coc_forms WHERE id=$1", [id]);
    const form = formResult.rows[0];
    if (!form) throw new Error("Record not found");

    const rows = (await pool.query(
        "SELECT * FROM coc_sample_rows WHERE form_id=$1 ORDER BY row_order,id",
        [id]
    )).rows;

    const monitors = (await pool.query(
        "SELECT * FROM coc_monitors WHERE form_id=$1 ORDER BY row_order,id",
        [id]
    )).rows;

    const jobs = (await pool.query(
        "SELECT * FROM coc_job_numbers WHERE form_id=$1 ORDER BY row_order,id",
        [id]
    )).rows;

    return { form, rows, monitors, jobs };
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
    const usable = monitors.length ? monitors : [{}];

    return usable.map(monitor => `
        <tr class="monitor-row">
            <td class="${activeRoleClass(role, "driver")}">
                <input name="monitor_sn[]" value="${escapeHtml(monitor.monitor_sn)}" ${readonly(canEditDriver)} ${requiredAttr(canEditDriver, "Monitor S/N")}>
            </td>
            ${canEditDriver ? `<td class="action-cell"><button type="button" class="small-button danger" onclick="removeMonitorRow(this)">Remove</button></td>` : ""}
        </tr>
    `).join("");
}

function renderJobRows(role, jobs, form = {}) {
    const canEditDriver = role === "driver" && !form.driver_locked;
    const usable = jobs.length ? jobs : [{}];

    return usable.map(job => `
        <tr class="job-row">
            <td class="${activeRoleClass(role, "driver")}">
                <input name="job_number[]" value="${escapeHtml(job.job_number)}" ${readonly(canEditDriver)} ${requiredAttr(canEditDriver, "Job Number")}>
            </td>
            ${canEditDriver ? `<td class="action-cell"><button type="button" class="small-button danger" onclick="removeJobRow(this)">Remove</button></td>` : ""}
        </tr>
    `).join("");
}

function renderSampleRows(role, rows, form = {}) {
    const canEditSite = role === "site" && !form.site_locked;
    const canEditDriver = role === "driver" && !form.driver_locked;
    const canEditLab = role === "lab" && !form.lab_locked;
    const usable = rows.length ? rows : [{}];

    return usable.map(row => {
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
                <td class="${activeRoleClass(role, "site")}"><input type="datetime-local" name="sample_collection_datetime[]" value="${dateTimeInput(row.sample_collection_datetime)}" ${readonly(canEditSite)} ${requiredAttr(canEditSite, "Sample Collection Date/Time")}></td>
                <td class="${activeRoleClass(role, "site")}"><input name="visit[]" value="${escapeHtml(row.visit)}" ${readonly(canEditSite)} ${requiredAttr(canEditSite, "Visit")}></td>
                <td class="${activeRoleClass(role, "driver")}"><input type="number" step="0.1" name="courier_pickup_temp[]" value="${escapeHtml(row.courier_pickup_temp)}" ${readonly(canEditDriver)} ${requiredAttr(canEditDriver, "Pickup Temperature")}></td>
                <td class="${activeRoleClass(role, "lab")}"><input type="number" name="tubes_received[]" value="${escapeHtml(row.tubes_received)}" ${readonly(canEditLab)} ${requiredAttr(canEditLab, "Tubes Received")}></td>
                <td class="${activeRoleClass(role, "lab")}"><input name="receiver_initial_date[]" value="${escapeHtml(row.receiver_initial_date)}" ${readonly(canEditLab)} ${requiredAttr(canEditLab, "Receiver Initial/Date")}></td>
                <td class="${activeRoleClass(role, "lab")}"><input name="comments[]" value="${escapeHtml(row.comments)}" ${readonly(canEditLab)}></td>
                <td class="${activeRoleClass(role, "lab")}"><input type="number" step="0.1" name="delivery_temp[]" value="${escapeHtml(row.delivery_temp)}" ${readonly(canEditLab)} ${requiredAttr(canEditLab, "Delivery Temperature")}></td>

                ${canEditSite ? `<td class="action-cell"><button type="button" class="small-button danger" onclick="removeSampleRow(this)">Remove</button></td>` : ""}
            </tr>
        `;
    }).join("");
}

function renderForm(role, form = {}, rows = [], monitors = [], jobs = []) {
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
.active-site{background:#dff0ff;}
.active-driver{background:#fff2b8;}
.active-lab{background:#dff8e8;}
.role-key{display:flex;gap:10px;margin:8px 0;font-size:11px;align-items:center;}
.role-key span{display:inline-flex;align-items:center;gap:4px;}
.role-dot{width:12px;height:12px;border:1px solid #9aa6b2;display:inline-block;}
.dot-site{background:#dff0ff;}
.dot-driver{background:#fff2b8;}
.dot-lab{background:#dff8e8;}
.instruction-box{margin:8px 0;padding:8px 10px;background:#f5f7fa;border-left:4px solid #1f3a5f;font-size:12px;}
.owner-box{margin:8px 0;padding:8px 10px;background:#eef4fb;border:1px solid #c9d8e8;font-size:12px;display:flex;justify-content:space-between;align-items:center;}
.owner-box a{background:#1f3a5f;color:white;text-decoration:none;padding:7px 10px;border-radius:4px;}
.choice-group{border:1px solid #b7c0ca;border-radius:3px;padding:4px;background:#fff;font-size:10px;}
.choice-line{font-weight:normal;display:flex;gap:5px;align-items:flex-start;margin:3px 0;}
.choice-line input{width:auto;margin-top:1px;}
.note-cell{font-weight:bold;line-height:1.3;background:#fff7e6;font-size:11px;}
.main-grid{display:grid;grid-template-columns:150px 1fr;gap:8px;align-items:start;}
.monitor-table th,.monitor-table td,.job-table th,.job-table td{font-size:10px;}
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
.missing-field,.required-empty{border:1px solid #b7c0ca!important;background:inherit!important;}
.required-cell{box-shadow:none;}
.lock-badge{font-weight:bold;color:#7a4b00;}
.modal-backdrop{position:fixed;inset:0;background:rgba(15,23,42,.42);display:none;align-items:center;justify-content:center;z-index:9999;}
.modal-card{width:420px;background:white;border-radius:8px;box-shadow:0 20px 45px rgba(0,0,0,.25);padding:22px;}
.modal-card h3{margin:0 0 10px;color:#1f3a5f;font-size:18px;}
.modal-card pre{white-space:pre-wrap;font-family:Arial,sans-serif;font-size:13px;line-height:1.35;color:#1f2933;background:#f5f7fa;border:1px solid #d8e0ea;padding:10px;border-radius:5px;max-height:260px;overflow:auto;}
.modal-actions{display:flex;gap:10px;margin-top:14px;}
.modal-actions button{flex:1;}
.modal-actions .secondary-action{background:#eef4fb;color:#1f3a5f;border:1px solid #c9d8e8;}
@page{size:A4 landscape;margin:8mm;}
@media print{body{background:white;padding:0;}.form-shell{width:100%;min-height:auto;box-shadow:none;padding:0;}.button-row,.role-key,.instruction-box,.owner-box{display:none;}}
</style>
</head>
<body>
<div class="form-shell">
<form id="ecocForm" method="POST" action="/add">
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
    <span><i class="role-dot dot-site"></i> Site fields ${form.site_locked ? "<span class='lock-badge'>(locked)</span>" : ""}</span>
    <span><i class="role-dot dot-driver"></i> Driver fields ${form.driver_locked ? "<span class='lock-badge'>(locked)</span>" : ""}</span>
    <span><i class="role-dot dot-lab"></i> Lab fields ${form.lab_locked ? "<span class='lock-badge'>(locked)</span>" : ""}</span>
</div>

<div class="instruction-box"><strong>Your section:</strong> ${escapeHtml(roleInstructions(role, form))}</div>

${isOwner && form.id ? `<div class="owner-box"><span>Owner access: manage which sections can be edited again.</span><a href="/owner/${form.id}">Manage Access</a></div>` : ""}

<table>
<tr>
<td class="${activeRoleClass(role, "site")}">
<label>Protocol Name</label>
<select name="protocol_name" onchange="toggleOther(this,'protocolOther')" ${disabled(canEditSite)} ${requiredAttr(canEditSite, "Protocol Name")}>${renderOptions(protocolOptions, protocolIsOther ? "Other" : form.protocol_name)}</select>
${!canEditSite ? `<input type="hidden" name="protocol_name" value="${escapeHtml(form.protocol_name || "")}">` : ""}
<input id="protocolOther" name="protocolOther" class="${protocolIsOther ? "" : "hidden"}" value="${protocolIsOther ? escapeHtml(form.protocol_name) : ""}" placeholder="Enter protocol">
</td>

<td class="${activeRoleClass(role, "site")}">
<label>Shipping Date</label>
<input type="date" name="shipping_date" value="${dateOnly(form.shipping_date) || todayDate()}" ${readonly(canEditSite)} ${requiredAttr(canEditSite, "Shipping Date")}>
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
<div class="choice-group">${renderSiteOptions(siteIsOther ? "Other" : form.site_name, canEditSite)}</div>
${!canEditSite ? `<input type="hidden" name="site_name" value="${escapeHtml(form.site_name || "")}">` : ""}
<input id="siteOther" name="siteOther" class="${siteIsOther ? "" : "hidden"}" value="${siteIsOther ? escapeHtml(form.site_name) : ""}" placeholder="Enter site">
</td>

<td class="${activeRoleClass(role, "site")}">
<label>Shipped By</label>
<input name="shipped_by" value="${escapeHtml(form.shipped_by)}" ${readonly(canEditSite)} placeholder="Name and surname" ${requiredAttr(canEditSite, "Shipped By")}>
</td>

<td class="${activeRoleClass(role, "driver")}">
<label>Courier Collection Date & Time</label>
<input type="datetime-local" name="courier_collection_datetime" value="${dateTimeInput(form.courier_collection_datetime)}" ${readonly(canEditDriver)} ${requiredAttr(canEditDriver, "Courier Collection Date & Time")}>
</td>

<td class="${activeRoleClass(role, "lab")}">
<label>Delivery Date & Time</label>
<input type="datetime-local" name="delivery_datetime" value="${dateTimeInput(form.delivery_datetime)}" ${readonly(canEditLab)} ${requiredAttr(canEditLab, "Delivery Date & Time")}>
</td>
</tr>

<tr><td colspan="4" class="note-cell">Note: This log must physically accompany the samples.</td></tr>
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
<thead><tr><th class="${activeRoleClass(role, "driver")}">Monitor S/N</th>${canEditDriver ? `<th>Action</th>` : ""}</tr></thead>
<tbody id="monitorRows">${renderMonitorRows(role, monitors, form)}</tbody>
</table>
${canEditDriver ? `<button type="button" class="small-button" style="margin-top:6px;width:100%;" onclick="addMonitorRow()">Add Monitor</button>` : ""}

<table class="job-table">
<thead><tr><th class="${activeRoleClass(role, "driver")}">Job Number</th>${canEditDriver ? `<th>Action</th>` : ""}</tr></thead>
<tbody id="jobRows">${renderJobRows(role, jobs, form)}</tbody>
</table>
${canEditDriver ? `<button type="button" class="small-button" style="margin-top:6px;width:100%;" onclick="addJobRow()">Add Job Number</button>` : ""}
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
<tbody id="sampleRows">${renderSampleRows(role, rows, form)}</tbody>
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

<div id="validationModal" class="modal-backdrop">
<div class="modal-card">
<h3 id="validationTitle">Review Required</h3>
<pre id="validationMessage"></pre>
<div class="modal-actions">
<button type="button" class="secondary-action" onclick="closeValidationModal()">Go Back</button>
<button type="button" onclick="submitAnyway()">Save Anyway</button>
</div>
</div>
</div>

<script>
let allowSubmit = false;

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
    });
});

function addSampleRow(){
    const tbody = document.getElementById("sampleRows");
    const tr = document.createElement("tr");
    tr.className = "sample-row";
    tr.innerHTML = \`
        <td class="${activeRoleClass(role, "site")}"><select name="sample_type[]" data-required-label="Sample Type">
            <option value="4ml EDTA">4ml EDTA</option><option value="6ml EDTA">6ml EDTA</option><option value="4ml SST">4ml SST</option><option value="Urine">Urine</option><option value="PK Plasma Aliquots">PK Plasma Aliquots</option><option value="Spot Sputum">Spot Sputum</option>
        </select></td>
        <td class="${activeRoleClass(role, "site")}"><select name="shipping_temp[]" onchange="toggleRowOther(this)" data-required-label="Shipping Temperature">
            <option value="Ambient 15-25">Ambient 15-25</option><option value="Refrigerated 2-8">Refrigerated 2-8</option><option value="Frozen -80">Frozen -80</option><option value="LN2 -196">LN2 -196</option><option value="Other">Other</option>
        </select><input name="shipping_temp_other[]" class="hidden" placeholder="Enter temp condition"></td>
        <td class="${activeRoleClass(role, "site")}"><input type="number" name="tubes_sent[]" data-required-label="Tubes Sent"></td>
        <td class="${activeRoleClass(role, "site")}"><input type="datetime-local" name="sample_collection_datetime[]" data-required-label="Sample Collection Date/Time"></td>
        <td class="${activeRoleClass(role, "site")}"><input name="visit[]" data-required-label="Visit"></td>
        <td class="${activeRoleClass(role, "driver")}"><input type="number" step="0.1" name="courier_pickup_temp[]" readonly></td>
        <td class="${activeRoleClass(role, "lab")}"><input type="number" name="tubes_received[]" readonly></td>
        <td class="${activeRoleClass(role, "lab")}"><input name="receiver_initial_date[]" readonly></td>
        <td class="${activeRoleClass(role, "lab")}"><input name="comments[]" readonly></td>
        <td class="${activeRoleClass(role, "lab")}"><input type="number" step="0.1" name="delivery_temp[]" readonly></td>
        <td class="action-cell"><button type="button" class="small-button danger" onclick="removeSampleRow(this)">Remove</button></td>\`;
    tbody.appendChild(tr);
}

function removeSampleRow(button){
    const rows = document.querySelectorAll(".sample-row");
    if(rows.length <= 1) return;
    button.closest("tr").remove();
}

function addMonitorRow(){
    const tbody = document.getElementById("monitorRows");
    const tr = document.createElement("tr");
    tr.className = "monitor-row";
    tr.innerHTML = \`<td class="${activeRoleClass(role, "driver")}"><input name="monitor_sn[]" data-required-label="Monitor S/N"></td><td class="action-cell"><button type="button" class="small-button danger" onclick="removeMonitorRow(this)">Remove</button></td>\`;
    tbody.appendChild(tr);
}

function removeMonitorRow(button){
    const rows = document.querySelectorAll(".monitor-row");
    if(rows.length <= 1) return;
    button.closest("tr").remove();
}

function addJobRow(){
    const tbody = document.getElementById("jobRows");
    const tr = document.createElement("tr");
    tr.className = "job-row";
    tr.innerHTML = \`<td class="${activeRoleClass(role, "driver")}"><input name="job_number[]" data-required-label="Job Number"></td><td class="action-cell"><button type="button" class="small-button danger" onclick="removeJobRow(this)">Remove</button></td>\`;
    tbody.appendChild(tr);
}

function removeJobRow(button){
    const rows = document.querySelectorAll(".job-row");
    if(rows.length <= 1) return;
    button.closest("tr").remove();
}

function getMissingFields(){
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
    return missing;
}

function getTemperatureWarnings(){
    const warnings = [];
    document.querySelectorAll(".sample-row").forEach((row, index) => {
        const tempSelect = row.querySelector('select[name="shipping_temp[]"]');
        const tempHidden = row.querySelector('input[type="hidden"][name="shipping_temp[]"]');
        const pickupInput = row.querySelector('input[name="courier_pickup_temp[]"]');
        if(!pickupInput || pickupInput.readOnly || pickupInput.disabled) return;
        const selectedTemp = tempSelect && !tempSelect.disabled ? tempSelect.value : (tempHidden ? tempHidden.value : "");
        const pickup = parseFloat(pickupInput.value);
        if(isNaN(pickup)) return;
        let min = null, max = null;
        if(selectedTemp === "Ambient 15-25"){ min = 15; max = 25; }
        if(selectedTemp === "Refrigerated 2-8"){ min = 2; max = 8; }
        if(min === null || max === null) return;
        if(pickup < min || pickup > max){
            warnings.push("Sample row " + (index + 1) + ": pickup temperature " + pickup + "°C is outside " + selectedTemp + " range.");
        }
    });
    return warnings;
}

function showValidationModal(title, message){
    document.getElementById("validationTitle").textContent = title;
    document.getElementById("validationMessage").textContent = message;
    document.getElementById("validationModal").style.display = "flex";
}

function closeValidationModal(){
    document.getElementById("validationModal").style.display = "none";
}

function submitAnyway(){
    allowSubmit = true;
    document.getElementById("ecocForm").submit();
}

document.getElementById("ecocForm").addEventListener("submit", function(event){
    if(allowSubmit) return;
    const missing = getMissingFields();
    const tempWarnings = getTemperatureWarnings();
    const messages = [];
    if(missing.length){
        messages.push("The following field(s) have not been completed:\\n" + missing.map(item => "- " + item).join("\\n"));
    }
    if(tempWarnings.length){
        messages.push("Temperature warning(s):\\n" + tempWarnings.map(item => "- " + item).join("\\n"));
    }
    if(messages.length){
        event.preventDefault();
        showValidationModal("Review Before Saving", messages.join("\\n\\n") + "\\n\\nChoose Go Back to review the form, or Save Anyway if this is intentional.");
    }
});
</script>
</body>
</html>
`;
}

async function replaceSamples(formId, d) {
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

    await pool.query("DELETE FROM coc_sample_rows WHERE form_id=$1", [formId]);

    for (let i = 0; i < sampleTypes.length; i++) {
        const temp = shippingTemps[i] === "Other" ? shippingTempOthers[i] : shippingTemps[i];
        await pool.query(`
            INSERT INTO coc_sample_rows (
                form_id,row_order,sample_type,shipping_temp,shipping_temp_other,tubes_sent,
                sample_collection_datetime,visit,courier_pickup_temp,
                tubes_received,receiver_initial_date,comments,delivery_temp
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        `, [
            formId, i, sampleTypes[i], temp, shippingTempOthers[i], tubesSent[i],
            collectionTimes[i] || null, visits[i], pickupTemps[i] || null,
            tubesReceived[i] || null, receiverInitialDates[i], comments[i], deliveryTemps[i] || null
        ]);
    }
}

async function replaceMonitors(formId, d) {
    const monitors = normalizeArray(d.monitor_sn);
    await pool.query("DELETE FROM coc_monitors WHERE form_id=$1", [formId]);

    for (let i = 0; i < monitors.length; i++) {
        if (String(monitors[i] || "").trim()) {
            await pool.query(
                "INSERT INTO coc_monitors (form_id,row_order,monitor_sn) VALUES ($1,$2,$3)",
                [formId, i, monitors[i]]
            );
        }
    }
}

async function replaceJobs(formId, d) {
    const jobs = normalizeArray(d.job_number);
    await pool.query("DELETE FROM coc_job_numbers WHERE form_id=$1", [formId]);

    for (let i = 0; i < jobs.length; i++) {
        if (String(jobs[i] || "").trim()) {
            await pool.query(
                "INSERT INTO coc_job_numbers (form_id,row_order,job_number) VALUES ($1,$2,$3)",
                [formId, i, jobs[i]]
            );
        }
    }
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

async function replaceRowsDirectly(formId, rows) {
    await pool.query("DELETE FROM coc_sample_rows WHERE form_id=$1", [formId]);

    for (let index = 0; index < rows.length; index++) {
        const row = rows[index];
        await pool.query(`
            INSERT INTO coc_sample_rows (
                form_id,row_order,sample_type,shipping_temp,shipping_temp_other,tubes_sent,
                sample_collection_datetime,visit,courier_pickup_temp,
                tubes_received,receiver_initial_date,comments,delivery_temp
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        `, [
            formId, index, row.sample_type, row.shipping_temp, row.shipping_temp_other,
            row.tubes_sent, row.sample_collection_datetime || null, row.visit,
            row.courier_pickup_temp || null, row.tubes_received || null,
            row.receiver_initial_date, row.comments, row.delivery_temp || null
        ]);
    }
}

async function lockRoleSection(formId, role) {
    const map = { site: "site_locked", driver: "driver_locked", lab: "lab_locked" };
    if (!map[role]) return;
    await pool.query(`UPDATE coc_forms SET ${map[role]}=TRUE WHERE id=$1`, [formId]);
}

async function generatePdfBuffer(formId) {
    const { form, rows, monitors, jobs } = await getFormBundle(formId);

    return new Promise(async (resolve, reject) => {
        const doc = new PDFDocument({ margin: 24, size: "A4", layout: "landscape" });
        const chunks = [];
        doc.on("data", c => chunks.push(c));
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        doc.on("error", reject);

        const navy = "#1f3a5f";
        const paleBlue = "#edf4fb";
        const lightGrey = "#f5f7fa";
        const border = "#9aa6b2";
        const text = "#202833";
        const year = new Date().getFullYear();
        const docRefNum = `IC-${year}-${String(formId).padStart(4, "0")}`;

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
        if (fs.existsSync(logoPath)) doc.image(logoPath, 26, 8, { width: 72 });

        doc.fillColor(navy).font("Helvetica-Bold").fontSize(17).text("Electronic Chain of Custody Form", 0, 26, { align: "center" });
        doc.fillColor(text).font("Helvetica").fontSize(7).text(
            "IC Labs Contact Information:\n0211407190 | info@iclabs.co.za\nGround Floor Albion Springs\n183 Main Road, Rondebosch\nCape Town, Western Cape, South Africa",
            585, 16, { width: 230, align: "right", lineGap: 1 }
        );

        try {
            const pngBuffer = await bwipjs.toBuffer({ bcid: "code128", text: docRefNum, scale: 1.1, height: 6, includetext: false });
            doc.image(pngBuffer, 681, 84, { width: 110 });
        } catch (e) {}

        doc.fillColor(navy).font("Helvetica-Bold").fontSize(8).text(`Document Ref: ${docRefNum}`, 24, 86);

        const startY = 108;
        const cellW = 197;
        const cellH = 34;

        cell(24, startY, cellW, cellH, "Protocol Name", form.protocol_name, { fill: paleBlue });
        cell(24 + cellW, startY, cellW, cellH, "Shipping Date", dateOnly(form.shipping_date), { fill: paleBlue });
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
        cell(24, reqY + 68, 132, 52, "Monitor S/N", monitors.length ? monitors.map(m => m.monitor_sn).join("\n") : "-", { valueSize: 7 });
        cell(24, reqY + 120, 132, 52, "Job Number", jobs.length ? jobs.map(j => j.job_number).join("\n") : "-", { valueSize: 7 });

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
                row.sample_type, row.shipping_temp, row.tubes_sent, formatDateTime(row.sample_collection_datetime),
                row.visit, row.courier_pickup_temp, row.tubes_received, row.receiver_initial_date, row.comments, row.delivery_temp
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
            24, footerY + 8, { width: doc.page.width - 48, align: "center" }
        );

        doc.end();
    });
}

async function generateSiteQrPdfBuffer(req, targetSlug) {
    const result = await pool.query("SELECT id,requisition_number,pid,site_name,shipping_date FROM coc_forms ORDER BY shipping_date DESC,id DESC");
    const forms = result.rows.filter(row => siteSlug(row.site_name) === targetSlug);
    const baseUrl = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;

    return new Promise(async (resolve, reject) => {
        const doc = new PDFDocument({ margin: 40, size: "A4" });
        const chunks = [];
        doc.on("data", c => chunks.push(c));
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        doc.on("error", reject);

        doc.font("Helvetica-Bold").fontSize(18).fillColor("#1f3a5f").text("eCOC QR Codes", { align: "center" });
        doc.moveDown();
        doc.font("Helvetica").fontSize(10).fillColor("#202833").text(forms[0] ? forms[0].site_name : "No site records found", { align: "center" });

        let x = 45;
        let y = 110;

        for (const form of forms) {
            if (y > 700) {
                doc.addPage();
                x = 45;
                y = 60;
            }

            const link = `${baseUrl}/form/${form.id}`;
            const qrBuffer = await QRCode.toBuffer(link, { width: 110, margin: 1 });

            doc.rect(x, y, 240, 150).stroke("#9aa6b2");
            doc.image(qrBuffer, x + 10, y + 20, { width: 105 });

            doc.font("Helvetica-Bold").fontSize(9).fillColor("#1f3a5f").text("Requisition:", x + 125, y + 22);
            doc.font("Helvetica").fontSize(9).fillColor("#202833").text(form.requisition_number || "-", x + 125, y + 36, { width: 100 });

            doc.font("Helvetica-Bold").fontSize(9).fillColor("#1f3a5f").text("PID:", x + 125, y + 62);
            doc.font("Helvetica").fontSize(9).fillColor("#202833").text(form.pid || "-", x + 125, y + 76, { width: 100 });

            doc.font("Helvetica").fontSize(6).fillColor("#5b6775").text(link, x + 10, y + 130, { width: 220 });

            if (x === 45) x = 310;
            else {
                x = 45;
                y += 175;
            }
        }

        doc.end();
    });
}

function renderAuthCard(title, bodyHtml) {
    return `
<html>
<head>
<title>${escapeHtml(title)}</title>
<style>
body{font-family:Arial,sans-serif;margin:0;min-height:100vh;background:linear-gradient(135deg,#eef4f8,#d9e4ec);display:flex;align-items:center;justify-content:center;color:#1f2933;}
.card{width:390px;max-width:calc(100vw - 32px);background:white;padding:34px;border-radius:10px;box-shadow:0 12px 30px rgba(31,58,95,.18);text-align:center;}
.logo{width:150px;margin-bottom:12px;}
h1{font-size:22px;margin:8px 0 4px;color:#1f3a5f;}
p{margin:0 0 24px;font-size:13px;color:#5b6775;}
label{display:block;text-align:left;font-size:13px;font-weight:bold;margin:12px 0 5px;}
input,select{width:100%;box-sizing:border-box;padding:10px;border:1px solid #b7c0ca;border-radius:5px;font-size:14px;}
button,.link-button{display:block;box-sizing:border-box;width:100%;margin-top:14px;padding:11px;background:#1f3a5f;color:white;border:none;border-radius:5px;cursor:pointer;font-size:15px;font-weight:bold;text-decoration:none;}
.secondary{background:#eef4fb;color:#1f3a5f;border:1px solid #c9d8e8;}
.status-message{min-height:18px;margin:10px 0 0;font-size:12px;color:#5b6775;text-align:left;}
.scanner-preview{display:none;width:100%;margin-top:12px;border-radius:6px;background:#101820;}
hr{border:none;border-top:1px solid #e1e7ef;margin:24px 0;}
</style>
</head>
<body>
<div class="card">
<img src="/IC_Labs_Logo.png" class="logo">
${bodyHtml}
</div>
</body>
</html>`;
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
        const destination = req.session.returnTo || "/search";
        delete req.session.returnTo;
        return res.redirect(destination);
    }

    res.send(renderAuthCard("Login Failed", `
        <h1>Login Failed</h1>
        <p>Invalid role or password.</p>
        <a class="link-button" href="/login">Try Again</a>
    `));
});

app.get("/logout", (req, res) => {
    req.session.destroy(() => res.redirect("/login"));
});

app.get("/search", requireLogin, (req, res) => {
    const role = req.session.role;

    res.send(renderAuthCard("eCOC Options", `
        <h1>eCOC Options</h1>
        <p>${escapeHtml(role.toUpperCase())} access</p>

        <form id="searchForm" method="GET" action="/load">
            <label>Load Existing eCOC</label>
            <input id="reqnum" name="reqnum" placeholder="Scan or enter Requisition Number" autocomplete="off" autofocus>
            <button type="submit">Load Form</button>
            <button type="button" id="scanButton" class="secondary">Scan Barcode</button>
            <video id="scannerPreview" class="scanner-preview" playsinline muted></video>
            <div id="scanStatus" class="status-message"></div>
        </form>

        <script>
        (() => {
            const form = document.getElementById("searchForm");
            const input = document.getElementById("reqnum");
            const scanButton = document.getElementById("scanButton");
            const video = document.getElementById("scannerPreview");
            const status = document.getElementById("scanStatus");
            let activeStream = null;
            let scanning = false;

            function setStatus(message) {
                status.textContent = message || "";
            }

            function stopScanner() {
                scanning = false;
                if (activeStream) {
                    activeStream.getTracks().forEach(track => track.stop());
                    activeStream = null;
                }
                video.style.display = "none";
                video.srcObject = null;
                scanButton.textContent = "Scan Barcode";
            }

            function submitScannedValue(rawValue) {
                let value = String(rawValue || "").trim();
                if (!value) return;

                try {
                    const scannedUrl = new URL(value, window.location.origin);
                    const reqFromUrl = scannedUrl.searchParams.get("reqnum") || scannedUrl.searchParams.get("requisition_number");
                    if (reqFromUrl) value = reqFromUrl.trim();
                    else if (scannedUrl.origin === window.location.origin && /^\\/form\\/\\d+/.test(scannedUrl.pathname)) {
                        window.location.href = scannedUrl.pathname;
                        return;
                    }
                } catch (error) {
                    // Plain barcode values are expected, so URL parsing failures are ignored.
                }

                value = value.replace(/^(req|requisition|requisition number)\\s*[:#-]?\\s*/i, "").trim();
                input.value = value;
                stopScanner();
                form.submit();
            }

            scanButton.addEventListener("click", async () => {
                if (scanning) {
                    stopScanner();
                    setStatus("");
                    return;
                }

                if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                    setStatus("Camera access is not available in this browser.");
                    return;
                }

                if (!("BarcodeDetector" in window)) {
                    setStatus("Barcode scanning is not supported here. Use Chrome or Edge, or scan with a USB scanner into the box.");
                    return;
                }

                try {
                    const detector = new BarcodeDetector({
                        formats: ["code_128", "code_39", "code_93", "codabar", "ean_13", "ean_8", "itf", "qr_code", "upc_a", "upc_e"]
                    });

                    activeStream = await navigator.mediaDevices.getUserMedia({
                        video: { facingMode: "environment" },
                        audio: false
                    });

                    video.srcObject = activeStream;
                    video.style.display = "block";
                    scanButton.textContent = "Stop Scanning";
                    setStatus("Point the camera at the barcode.");
                    scanning = true;
                    await video.play();

                    const scanFrame = async () => {
                        if (!scanning) return;
                        try {
                            const codes = await detector.detect(video);
                            if (codes.length) {
                                submitScannedValue(codes[0].rawValue);
                                return;
                            }
                        } catch (error) {
                            setStatus("Still looking for a barcode...");
                        }
                        requestAnimationFrame(scanFrame);
                    };

                    scanFrame();
                } catch (error) {
                    stopScanner();
                    setStatus("Camera permission was blocked or no camera was found.");
                }
            });
        })();
        </script>

        ${role === "site" ? `
            <hr>
            <form method="GET" action="/form">
                <button type="submit">Start New eCOC</button>
            </form>
        ` : ""}

        <a class="link-button secondary" href="/sites">Site Folders</a>
        <a class="link-button secondary" href="/view-pdfs">All eCOCs</a>
        <a class="link-button secondary" href="/logout">Log Out</a>
    `));
});

app.get("/load", requireLogin, async (req, res) => {
    const { reqnum } = req.query;
    const role = req.session.role;

    if (!reqnum) return res.send("Invalid requisition number");

    const result = await pool.query("SELECT * FROM coc_forms WHERE requisition_number=$1", [reqnum]);

    if (!result.rows[0]) {
        if (role === "site") return res.redirect(`/form?newReq=${encodeURIComponent(reqnum)}`);
        return res.send(`No record found for Requisition Number: ${escapeHtml(reqnum)}`);
    }

    res.redirect(`/form/${result.rows[0].id}`);
});

app.get("/form", requireRole("site"), (req, res) => {
    const role = req.session.role;
    const newReq = req.query.newReq;
    const form = newReq
        ? { requisition_number: newReq, site_locked: false, driver_locked: false, lab_locked: false }
        : { site_locked: false, driver_locked: false, lab_locked: false };

    res.send(renderForm(role, form, [{}], [{}], [{}]));
});

app.get("/form/:id", requireLogin, async (req, res) => {
    try {
        const { form, rows, monitors, jobs } = await getFormBundle(req.params.id);
        res.send(renderForm(req.session.role, form, rows, monitors, jobs));
    } catch (err) {
        res.send("Record not found");
    }
});

app.post("/add", requireRole("site", "driver", "lab"), async (req, res) => {
    const d = req.body;
    const role = req.session.role;
    const protocol = d.protocol_name === "Other" ? d.protocolOther : d.protocol_name;
    const site = d.site_name === "Other" ? d.siteOther : d.site_name;

    try {
        if (d.id) {
            const { form: existingForm, rows: existingRows } = await getFormBundle(d.id);

            if ((role === "site" && existingForm.site_locked) ||
                (role === "driver" && existingForm.driver_locked) ||
                (role === "lab" && existingForm.lab_locked)) {
                return res.send("This section is locked. Please contact the owner to allow edits.");
            }

            const updated = {
                protocol_name: role === "site" ? protocol : existingForm.protocol_name,
                site_name: role === "site" ? site : existingForm.site_name,
                shipping_date: role === "site" ? d.shipping_date : dateOnly(existingForm.shipping_date),
                courier_name: role === "driver" ? d.courier_name : existingForm.courier_name,
                page_numbers: role === "site" ? d.page_numbers : existingForm.page_numbers,
                shipped_by: role === "site" ? d.shipped_by : existingForm.shipped_by,
                courier_collection_datetime: role === "driver" ? d.courier_collection_datetime : existingForm.courier_collection_datetime,
                delivery_datetime: role === "lab" ? d.delivery_datetime : existingForm.delivery_datetime,
                requisition_number: role === "site" ? d.requisition_number : existingForm.requisition_number,
                pid: role === "site" ? d.pid : existingForm.pid
            };

            await pool.query(`
                UPDATE coc_forms SET
                    protocol_name=$1, site_name=$2, shipping_date=$3, courier_name=$4,
                    page_numbers=$5, shipped_by=$6, courier_collection_datetime=$7,
                    delivery_datetime=$8, requisition_number=$9, pid=$10,
                    updated_at=CURRENT_TIMESTAMP
                WHERE id=$11
            `, [
                updated.protocol_name, updated.site_name, updated.shipping_date || null, updated.courier_name,
                updated.page_numbers, updated.shipped_by, updated.courier_collection_datetime || null,
                updated.delivery_datetime || null, updated.requisition_number, updated.pid, d.id
            ]);

            const mergedRows = mergeRowsForRole(role, d, existingRows);
            await replaceRowsDirectly(d.id, mergedRows);

            if (role === "driver") {
                await replaceMonitors(d.id, d);
                await replaceJobs(d.id, d);
            }

            await lockRoleSection(d.id, role);
            return res.redirect(`/form/${d.id}`);
        }

        if (role !== "site") return res.send("Only the site role can start a new eCOC.");

        const insert = await pool.query(`
            INSERT INTO coc_forms (
                protocol_name, site_name, shipping_date, courier_name, page_numbers,
                shipped_by, courier_collection_datetime, delivery_datetime,
                requisition_number, pid, site_locked, driver_locked, lab_locked
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,TRUE,FALSE,FALSE)
            RETURNING id
        `, [
            protocol, site, d.shipping_date || null, d.courier_name, d.page_numbers,
            d.shipped_by, d.courier_collection_datetime || null, d.delivery_datetime || null,
            d.requisition_number, d.pid
        ]);

        const formId = insert.rows[0].id;
        await replaceSamples(formId, d);
        res.redirect(`/form/${formId}`);
    } catch (err) {
        res.send("Save error: " + err.message);
    }
});

app.get("/owner/:id", requireRole("owner"), async (req, res) => {
    const result = await pool.query("SELECT * FROM coc_forms WHERE id=$1", [req.params.id]);
    const form = result.rows[0];
    if (!form) return res.send("Record not found");

    res.send(renderAuthCard("Owner Access Control", `
        <h1>Owner Access Control</h1>
        <p>Requisition: ${escapeHtml(form.requisition_number || "-")}</p>
        <form method="POST" action="/owner/${form.id}/access">
            <label><input type="checkbox" name="allow_site" ${form.site_locked ? "" : "checked"} style="width:auto;"> Allow Site to edit</label>
            <label><input type="checkbox" name="allow_driver" ${form.driver_locked ? "" : "checked"} style="width:auto;"> Allow Driver to edit</label>
            <label><input type="checkbox" name="allow_lab" ${form.lab_locked ? "" : "checked"} style="width:auto;"> Allow Lab to edit</label>
            <button type="submit">Update Access</button>
        </form>
        <a class="link-button secondary" href="/form/${form.id}">Back to Form</a>
    `));
});

app.post("/owner/:id/access", requireRole("owner"), async (req, res) => {
    await pool.query(`
        UPDATE coc_forms SET site_locked=$1, driver_locked=$2, lab_locked=$3, updated_at=CURRENT_TIMESTAMP
        WHERE id=$4
    `, [
        req.body.allow_site ? false : true,
        req.body.allow_driver ? false : true,
        req.body.allow_lab ? false : true,
        req.params.id
    ]);

    res.redirect(`/form/${req.params.id}`);
});

app.get("/sites", requireLogin, async (req, res) => {
    const result = await pool.query(`
        SELECT DISTINCT site_name FROM coc_forms
        WHERE site_name IS NOT NULL AND site_name <> ''
        ORDER BY site_name
    `);

    res.send(renderAuthCard("Site Folders", `
        <h1>Site Folders</h1>
        <p>Access eCOCs and QR codes by site</p>
        ${result.rows.map(row => `
            <a class="link-button secondary" href="/sites/${encodeURIComponent(siteSlug(row.site_name))}/ecocs">${escapeHtml(row.site_name)}</a>
        `).join("") || "<p>No sites yet.</p>"}
        <a class="link-button" href="/search">Back</a>
    `));
});

app.get("/sites/:slug/ecocs", requireLogin, async (req, res) => {
    const result = await pool.query("SELECT * FROM coc_forms ORDER BY shipping_date DESC,id DESC");
    const matching = result.rows.filter(row => siteSlug(row.site_name) === req.params.slug);
    const siteName = matching[0] ? matching[0].site_name : "No records found";

    res.send(renderAuthCard("Site eCOCs", `
        <h1>Site eCOCs</h1>
        <p>${escapeHtml(siteName)}</p>
        ${matching.map(row => `
            <a class="link-button secondary" href="/form/${row.id}">
                ${escapeHtml(row.requisition_number || `eCOC ${row.id}`)}
            </a>
        `).join("") || "<p>No eCOCs for this site.</p>"}
        ${matching.length ? `<a class="link-button secondary" href="/sites/${encodeURIComponent(req.params.slug)}/qrcodes">Download QR Codes</a>` : ""}
        <a class="link-button" href="/sites">Back to Sites</a>
    `));
});

app.get("/sites/:slug/qrcodes", requireLogin, async (req, res) => {
    const buffer = await generateSiteQrPdfBuffer(req, req.params.slug);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="qr-codes-${req.params.slug}.pdf"`);
    res.send(buffer);
});

app.get("/view-pdfs", requireLogin, async (req, res) => {
    const result = await pool.query("SELECT id,requisition_number,site_name,shipping_date FROM coc_forms ORDER BY shipping_date DESC,id DESC");

    res.send(renderAuthCard("All eCOCs", `
        <h1>All eCOCs</h1>
        <p>Generated from database records</p>
        ${result.rows.map(row => `
            <a class="link-button secondary" href="/download/${row.id}">
                ${escapeHtml(row.requisition_number || `eCOC ${row.id}`)} - ${escapeHtml(row.site_name || "No site")}
            </a>
        `).join("") || "<p>No eCOCs yet.</p>"}
        <a class="link-button" href="/search">Back</a>
    `));
});

app.get("/download/:id", requireLogin, async (req, res) => {
    try {
        const buffer = await generatePdfBuffer(req.params.id);
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename="eCOC_${req.params.id}.pdf"`);
        res.send(buffer);
    } catch (err) {
        res.send("PDF error: " + err.message);
    }
});

app.listen(PORT, () => {
    console.log("Server running on port " + PORT);
});
