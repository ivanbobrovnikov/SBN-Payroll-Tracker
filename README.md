# SBN Payroll tracker

Everyone's pay, across every location, in one place. **Owner-only and read-only**: it reads from your shop trackers and never changes anything in them.
It is a separate site from the rep tracker, with its own password, so the sales team never sees any of it.

## Set it up (once)
1. Put these files in a new GitHub repo (for example `sbn-payroll-tracker`) and deploy it on Railway as a **new service**, the same way as the other trackers.
2. In Railway, add a **Volume** to this service, mounted at `/data`, and add the variable `DATA_DIR=/data`. Without this, a redeploy would wipe the password and the locations.
3. Open the site. The first visit asks you to set the password (at least 8 characters). That is the only password.
4. Go to **Locations** and add each shop: a name, its tracker address (https://…), and its **cross-location secret** (the `CROSS_LOCATION_SECRET` variable on that shop's Railway service, the same one the rep tracker uses). Press **Test connection** on each.
5. Every shop must be on build `2026-10-26-payroll` or newer (`sbn-tracker-live.zip`), which adds the two read-only pay pieces this reads.

## Using it
* **By location** (the default) shows one section for each location, in the order set on the Locations tab: a tile on top for each location plus an All locations total, then everyone at that location with its own subtotal. **By person** adds each person up across locations instead.
* **Adding a location later:** deploy its tracker on the latest build, set its `CROSS_LOCATION_SECRET`, then add it on the **Locations** tab. It joins the end of the list and appears on the Payroll screen straight away. Nothing else needs to change. Use the arrows on that tab to reorder, and Rename to change a name.
* **Payroll** has two views: *Techs and managers* (the shops' shared pay schedule) and *Sales reps* (their own two-week Thursday to Wednesday period).
* A yellow **check before you pay** box lists problems at a location, like days with no attendance marked. It only shows for locations whose payroll has not been run yet.
* **Export spreadsheet** downloads a CSV of what is on screen. **Print** opens every breakdown first.
* People are matched by name across locations, so spell someone's name the same way everywhere.

## Security
* One password, stored as a salted hash. 8 wrong tries lock sign-in for 15 minutes. Logins last 30 days. Changing the password signs every other device out.
* The shops' secrets are kept on this server and are never sent back to the browser.
* There is no leaderboard, TV feed or any page for sales reps.
