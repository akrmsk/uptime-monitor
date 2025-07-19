// FILE: netlify/functions/checkWebsites.js
// This is a temporary, simplified version for debugging.

const { createClient } = require('@supabase/supabase-js');

exports.handler = async function(event, context) {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    console.log('--- STARTING DIAGNOSTIC CHECK ---');

    try {
        // This query will get ALL websites from the table, no matter who the user is.
        const { data: allWebsites, error } = await supabase
            .from('websites')
            .select('url, user_id');

        if (error) {
            console.error('DATABASE ERROR:', error.message);
            return { statusCode: 500, body: 'Failed to query database.' };
        }

        if (!allWebsites || allWebsites.length === 0) {
            console.log('RESULT: The websites table is empty.');
        } else {
            console.log(`RESULT: Found ${allWebsites.length} website(s) in the database.`);
            // This loop will print the details for each website found.
            allWebsites.forEach(site => {
                console.log(`- Website URL: ${site.url}, User ID attached: ${site.user_id}`);
            });
        }

        console.log('--- DIAGNOSTIC CHECK COMPLETE ---');
        return { statusCode: 200, body: 'Diagnostic check complete.' };

    } catch (e) {
        console.error('A critical error occurred:', e);
        return { statusCode: 500, body: 'Critical error.' };
    }
};