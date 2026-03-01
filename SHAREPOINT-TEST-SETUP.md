# How to open a SharePoint to test the pull feature

You can use a **free Microsoft 365 developer tenant** that includes SharePoint. No credit card required.

---

## 1. Get a free SharePoint (Microsoft 365 Developer Program)

1. Go to **[Microsoft 365 Developer Program](https://developer.microsoft.com/en-us/microsoft-365/dev-program)** and sign in with a Microsoft account.
2. Click **Join now** / **Set up E5 subscription**.
3. Choose **Instant sandbox** (ready in minutes, includes SharePoint + sample data).
4. Pick **Country/region**, set an **Admin username** and **Admin password**, then complete phone verification.
5. After setup, your tenant URL will look like: `https://<something>.sharepoint.com` (e.g. `https://contoso.sharepoint.com`).

**Important:** Save the admin username (e.g. `admin@contoso.onmicrosoft.com`) and password; you’ll use them to sign in and for the Azure app.

- Dashboard: [Microsoft 365 Developer Program dashboard](https://developer.microsoft.com/en-us/microsoft-365/profile)  
- Docs: [Set up a Microsoft 365 developer sandbox](https://learn.microsoft.com/en-us/office/developer-program/microsoft-365-developer-program-get-started)

---

## 2. Get your SharePoint site URL

1. Sign in to your dev tenant: [https://admin.microsoft.com](https://admin.microsoft.com) with `admin@<yourdomain>.onmicrosoft.com`.
2. In the app launcher (waffle), open **SharePoint**.
3. Open the site you want to use (e.g. “Team site” or the main site).
4. The browser URL is your **site URL**, e.g.:
   - `https://<tenant>.sharepoint.com/sites/YourSiteName`

Use this as `siteUrl` in the pull-sharepoint API. For the **root** of the default document library use `folderPath: ""` or `"Shared Documents"`; for a subfolder use e.g. `"Shared Documents/MyFolder"`.

---

## 3. Register an app in Azure (for Graph API)

The management system uses **Microsoft Graph** with **client credentials** (no user login). You need an app in the **same** Azure AD tenant as your SharePoint.

1. Open **[Azure Portal](https://portal.azure.com)** and sign in with the **same** account as your M365 dev tenant (`admin@<yourdomain>.onmicrosoft.com`). If the tenant is new, switch directory (top-right) to your dev tenant.
2. Go to **Microsoft Entra ID** (or **Azure Active Directory**) → **App registrations** → **New registration**.
3. **Name:** e.g. `Maneger SharePoint Pull`.  
   **Supported account types:** “Accounts in this organizational directory only”.  
   **Redirect URI:** leave blank.  
   Click **Register**.
4. On the app page, note:
   - **Application (client) ID** → this is `SHAREPOINT_CLIENT_ID`
   - **Directory (tenant) ID** → this is `SHAREPOINT_TENANT_ID`
5. **Create a client secret:**  
   **Certificates & secrets** → **New client secret** → add description, choose expiry → **Add**.  
   Copy the **Value** immediately (it’s shown only once) → this is `SHAREPOINT_CLIENT_SECRET`.
6. **API permissions:**  
   **API permissions** → **Add a permission** → **Microsoft Graph** → **Application permissions** → add:
   - **Sites.Read.All** (or **Files.Read.All**)  
   Then click **Grant admin consent for &lt;your org&gt;** so the app can access SharePoint without user login.

---

## 4. Configure and call the management API

In your `maneger-back` `.env`:

```env
SHAREPOINT_TENANT_ID=<Directory (tenant) ID from step 4>
SHAREPOINT_CLIENT_ID=<Application (client) ID from step 4>
SHAREPOINT_CLIENT_SECRET=<client secret value from step 5>
```

Restart the server, then call the pull endpoint (with a valid project and JWT):

```bash
curl -X POST "http://localhost:8001/api/projects/YOUR_PROJECT_ID/files/pull-sharepoint" \
  -H "Authorization: Bearer YOUR_JWT" \
  -H "Content-Type: application/json" \
  -d "{\"siteUrl\": \"https://YOUR-TENANT.sharepoint.com/sites/YOUR-SITE\", \"folderPath\": \"Shared Documents\"}"
```

Use the exact `siteUrl` from step 2. For root of the default library, `folderPath` can be `""` or `"Shared Documents"`. Response will list `ingested` and any `failed` files.

---

## Summary

| Step | What you get |
|------|----------------|
| 1 | Free M365 dev tenant with SharePoint (instant sandbox) |
| 2 | SharePoint site URL for `siteUrl` |
| 3 | Azure app + tenant ID, client ID, client secret + Sites.Read.All |
| 4 | Env vars + `POST .../files/pull-sharepoint` to test |

If you don’t want to use a real SharePoint at all, you can add a **mock mode** (e.g. env or body flag) that uses fake files and the same ingest flow; that can be added separately.
