// FILE: netlify/functions/checkWebsites.js
// This is the final, corrected version with a more robust logic.

const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');
const { Resend } = require('resend');

exports.handler = async function(event, context) {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
    const RESEND_API_KEY = process.env.RESEND_API_KEY;
    const FROM_EMAIL = process.env.FROM_EMAIL;

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const resend = new Resend(RESEND_API_KEY);

    console.log('Starting website check job.');

    try {
        // A simpler, more direct approach: Get all websites first.
        const { data: websites, error: websitesError } = await supabase
            .from('websites')
            .select('*');

        if (websitesError) throw websitesError;

        if (!websites || websites.length === 0) {
            console.log('No websites found in the database to check.');
            return { statusCode: 200, body: 'No websites to check.' };
        }

        console.log(`Found ${websites.length} total websites to process.`);

        // Process each website found.
        for (const site of websites) {
            let newStatus;
            try {
                const response = await fetch(site.url, { timeout: 10000 });
                newStatus = response.ok ? 'Up' : 'Down';
            } catch (fetchError) {
                console.error(`Fetch error for ${site.url}:`, fetchError.message);
                newStatus = 'Down';
            }

            // If the status has changed, update the database.
            if (newStatus !== site.status) {
                console.log(`Status for ${site.url} changed to ${newStatus}.`);
                await supabase
                    .from('websites')
                    .update({ status: newStatus, last_checked: new Date().toISOString() })
                    .eq('id', site.id);

                // If the site is down, find the user's email and send an alert.
                if (newStatus === 'Down') {
                    const { data: userData } = await supabase
                        .from('users')
                        .select('email')
                        .eq('id', site.user_id)
                        .single();

                    const userEmail = userData ? userData.email : null;

                    if (userEmail) {
                        await sendDownAlert(userEmail, site.url, resend, FROM_EMAIL);
                    } else {
                        console.log(`Site ${site.url} is down, but no email was found for user ${site.user_id}.`);
                    }
                }
            }
        }

        console.log('Successfully completed website check job.');
        return { statusCode: 200, body: 'Job completed successfully.' };

    } catch (error) {
        console.error('Error in checkWebsites job:', error);
        return { statusCode: 500, body: `Job failed: ${error.message}` };
    }
};

async function sendDownAlert(toEmail, url, resend, fromEmail) {
    try {
        console.log(`Attempting to send email to ${toEmail} for down site ${url}.`);
        const { data, error } = await resend.emails.send({
            from: `Uptime Monitor <${fromEmail}>`,
            to: [toEmail],
            subject: `🚨 Website Alert: ${url} is Down`,
            html: `<p>This is an automated alert. We detected that your website <strong>${url}</strong> is currently down.</p>`,
        });
        if (error) throw error;
        console.log(`Alert email sent successfully to ${toEmail}.`);
    } catch (error) {
        console.error('Error sending email via Resend:', error);
    }
}