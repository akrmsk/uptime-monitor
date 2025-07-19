// FILE: netlify/functions/checkWebsites.js 
// This is the updated backend code with extra logging.

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
        const { data: users, error: usersError } = await supabase.from('websites').select('user_id');
        if (usersError) throw usersError;
        if (!users || users.length === 0) {
            console.log('No websites to check.');
            return { statusCode: 200, body: 'No websites to check.' };
        }

        const userIds = [...new Set(users.map(u => u.user_id))];
        
        for (const userId of userIds) {
            await processUserWebsites(userId, supabase, resend, FROM_EMAIL);
        }

        console.log('Successfully completed website check job.');
        return { statusCode: 200, body: 'Job completed successfully.' };

    } catch (error) {
        console.error('Error in checkWebsites job:', error);
        return { statusCode: 500, body: `Job failed: ${error.message}` };
    }
};

async function processUserWebsites(userId, supabase, resend, fromEmail) {
    // --- NEW LOGGING START ---
    console.log(`Processing websites for user ID: ${userId}`);
    
    const { data: userData, error: userError } = await supabase.from('users').select('email').eq('id', userId).single();
    
    if (userError) {
        console.error(`DATABASE ERROR trying to get email for user ${userId}:`, userError.message);
    }
    
    console.log(`Result of email query for user ${userId}:`, userData);
    // --- NEW LOGGING END ---

    const userEmail = userData ? userData.email : null;

    const { data: websites, error: websitesError } = await supabase.from('websites').select('*').eq('user_id', userId);
    if (websitesError) {
        console.error(`Error fetching websites for user ${userId}:`, websitesError);
        return;
    }

    for (const site of websites) {
        let newStatus;
        try {
            const response = await fetch(site.url, { timeout: 10000 });
            newStatus = response.ok ? 'Up' : 'Down';
        } catch (fetchError) {
            newStatus = 'Down';
        }

        if (newStatus !== site.status) {
            const { error: updateError } = await supabase
                .from('websites')
                .update({ status: newStatus, last_checked: new Date().toISOString() })
                .eq('id', site.id);
            
            if (updateError) {
                console.error(`Error updating status for ${site.url}:`, updateError);
            } else {
                console.log(`Status for ${site.url} changed to ${newStatus}.`);
                if (newStatus === 'Down' && userEmail) {
                    await sendDownAlert(userEmail, site.url, resend, fromEmail);
                } else if (newStatus === 'Down' && !userEmail) {
                    // --- NEW LOGGING ---
                    console.log(`Site ${site.url} is down, but NO EMAIL was found for user ${userId}.`);
                }
            }
        }
    }
}

async function sendDownAlert(toEmail, url, resend, fromEmail) {
    try {
        console.log(`Attempting to send email to ${toEmail} for down site ${url}.`); // --- NEW LOGGING ---
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
