### Step 1: Create Your Cloudflare Worker
1. Sign in to your Cloudflare account dashboard
2. Navigate to the Workers & Pages section
3. Click "Create" and create a new worker
4. Copy the contents of the `worker.js` file from this repository
5. Paste the code into the worker editor, save your changes and deploy the worker

### Step 2: Set Up Your Database
1. Create a new D1 database in your Cloudflare dashboard
2. Download `database.sql` from the [release assets](https://github.com/wapanese/yomi-audio-worker/releases)
3. Import the database using one of these methods:
   - [Use Wrangler CLI](https://developers.cloudflare.com/d1/best-practices/import-export-data/): `wrangler d1 execute <DATABASE_NAME> --remote --file=database.sql`
   - Alternatively, use the [Cloudflare REST API for database imports](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/import/)

### Step 3: Connect Your Worker to the Database
1. Navigate to the Workers & Pages section
2. Select the worker you created in Step 1
3. Click on the "Settings" tab
4. Locate the "Bindings" section
5. Add a D1 database binding with the name `DB`
6. Select the database you created in Step 2
7. Save your configuration changes
