# 📺 Serverless IPTV Hub

A powerful, serverless IPTV web player powered entirely by Cloudflare Workers. It acts as a proxy to bypass CORS issues, manages M3U playlists using Cloudflare KV, and features a dual-sidebar UI with high-performance 12,000+ global channel search and paginated rendering! (This is a fork!)

<p align="center" dir="auto">
<img width="1920" height="953" alt="Serverless IPTV Hub" src="https://github.com/user-attachments/assets/c00fdfa1-8027-4d7c-aa8c-5a877c64796c" />
</p>

## ✨ Features
* **100% Serverless:** Runs purely on Cloudflare Workers edge network.
* **CORS Bypass:** Proxies video streams and M3U8 files so they play seamlessly in the browser.
* **Password Protected:** Built-in cookie-based authentication.
* **High Performance & Paginated UI:** Scroll-based card loading ensures 60fps responsiveness even with massive playlists.
* **Dual Sidebar Layout:** Interactive category panel with quick category filtering and rich channel management.
* **Source Management:** Add, edit, and manage multiple M3U URLs directly from the UI (saved to Cloudflare KV).
* **Favorites System:** Star your favorite channels (saved locally to your browser).

#### NEW **Global & Category Search:** Fast search across all 12,000+ channels or filtered within a selected category with instant scope switching.

---

## 🚀 Deployment Guide

You can deploy this to your own Cloudflare account for free in just a few minutes.

### 1. Create a Cloudflare Worker
1. Log in to your [Cloudflare Dashboard](https://dash.cloudflare.com/).
2. Navigate to **Compute** -> **Workers & Pages** from the left sidebar.
3. Click **Create Application**, then **Start with Hello World!**.
4. Name your worker (e.g., `serverless-iptv-hub`) and click **Deploy**.
5. Click **Edit code**. Clear the default code, paste the contents of `worker.js` from this repository ([https://github.com/yousefebrahimi0/Serverless-IPTV-Hub](https://github.com/yousefebrahimi0/Serverless-IPTV-Hub)), and click **Save and deploy**.

### 2. Setup Cloudflare KV (Storage)
To save your custom M3U sources and settings, you can bind a KV namespace.
1. Go back to your Cloudflare Dashboard.
2. Navigate to **Storage & Databases** -> **Workers KV**.
3. Click **Create Instance** and name it `IPTV_KV_STORE` (or whatever you like).
4. Go back to **Workers & Pages** and click on your newly created Worker.
5. Go to the **Bindings** tab.
6. Click **Add binding**, select **KV namespace**, and click **Add Binding**.
7. Set the **Variable name** to exactly: `IPTV_KV`
8. Select the KV namespace you created in step 3 and click **Add Binding**.

### 3. Setup Environment Variables (Security)
By default, the player uses `Admin@123` as the password. For security, it is **highly recommended** to change this by creating environment variables.
1. Navigate to your Worker's **Settings** tab, **Variables & Secrets** section.
2. Click **+ Add** and create the following two environment variables (keep them encrypted as secrets):
   * Variable Name: `LOGIN_PASSWORD` | Type: Secret | Value: *Your_Secure_Password*
   * Variable Name: `COOKIE_SECRET` | Type: Secret | Value: *A_Random_Secret_String* (e.g., `super-secret-key-998`)
3. Click **Deploy**.

### 4. Use Your Own Domain (Optional)
Want to access the player using your custom domain (e.g., `tv.yourdomain.com`) instead of the default `.workers.dev` link? 
1. Go to your Worker's page in the Cloudflare Dashboard.
2. Navigate to the **Domains** tab, then click **Add Domain**.
3. Under **Connect domain**, select the base domain you have already added to your Cloudflare account.
4. Enter your desired subdomain (e.g., `tv`) or root domain (*Note: your domain's DNS must be managed by Cloudflare*).
5. Click **Add domain** to save. Cloudflare will automatically configure the DNS records and SSL certificate for you!

🎉 **You're done!** Open your Worker's URL, log in (the default password is `Admin@123` if you didn't change it), and start watching!

---

## 📂 Managing Playlists

By default, the player loads the `active 12k list iptv.m3u` file hosted in this repository ([https://github.com/yousefebrahimi0/Serverless-IPTV-Hub](https://github.com/yousefebrahimi0/Serverless-IPTV-Hub)). 

If you want to check the active m3u files you can use this service: ([https://www.free-codecs.com/app/m3u-checker/)](https://www.free-codecs.com/app/m3u-checker/))

**The Easiest Way (UI):**
You don't need to edit any code to use your own playlists! Once you log into the player, simply click the **Settings (Gear Icon)** in the left sidebar. From there, you can add, edit, or remove as many remote M3U URLs as you want. These changes are saved directly to your Cloudflare KV and will override the default playlist.

**Advanced (Hardcoding a Default):**
If you prefer to permanently hardcode a different default playlist so it loads instantly without using the UI settings, you can edit the `DEFAULT_M3U_URL` variable at the top of the `worker.js` file to point to your own raw `.m3u` link.
