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