const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');
const { Resend } = require('resend');

// This is a scheduled function that runs every 5 minutes
exports.handler = async function(event, context) {
    // --- CONFIGURATION ---
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
    const RESEND_API_KEY = process.env.RESEND_API_KEY;
    const FROM_EMAIL = process.env.FROM_EMAIL;

    // Initialize clients
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const resend = new Resend(RESEND_API_KEY);

    console.log('Starting scheduled website check job.');

    try {
        // 1. Get all unique user IDs that have websites
        const { data: users, error: usersError } = await supabase
            .from('websites')
            .select('user_id');
        
        if (usersError) throw usersError;
        if (!users || users.length === 0) {
            console.log('No websites to check.');
            return { statusCode: 200, body: 'No websites to check.' };
        }

        // Get unique user IDs
        const userIds = [...new Set(users.map(u => u.user_id))];
        
        // 2. Process websites for each user
        for (const userId of userIds) {
            await processUserWebsites(userId, supabase, resend, FROM_EMAIL);
        }

        console.log('Successfully completed scheduled website check job.');
        return { statusCode: 200, body: 'Scheduled job completed successfully.' };

    } catch (error) {
        console.error('Error in scheduled checkWebsites job:', error);
        return { statusCode: 500, body: `Scheduled job failed: ${error.message}` };
    }
};

async function processUserWebsites(userId, supabase, resend, fromEmail) {
    // Get user's email
    const { data: userData } = await supabase.from('users').select('email').eq('id', userId).single();
    const userEmail = userData ? userData.email : null;

    // Get user's websites
    const { data: websites, error: websitesError } = await supabase
        .from('websites')
        .select('*')
        .eq('user_id', userId);

    if (websitesError) {
        console.error(`Error fetching websites for user ${userId}:`, websitesError);
        return;
    }

    for (const site of websites) {
        let newStatus;
        try {
            const response = await fetch(site.url, { 
                timeout: 10000,
                headers: {
                    'User-Agent': 'UptimeMonitor/1.0'
                }
            });
            newStatus = response.ok ? 'Up' : 'Down';
        } catch (fetchError) {
            console.error(`Fetch error for ${site.url}:`, fetchError.message);
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
                }
            }
        } else {
            // Update last_checked even if status didn't change
            const { error: updateError } = await supabase
                .from('websites')
                .update({ last_checked: new Date().toISOString() })
                .eq('id', site.id);
            
            if (updateError) {
                console.error(`Error updating last_checked for ${site.url}:`, updateError);
            }
        }
    }
}

async function sendDownAlert(toEmail, url, resend, fromEmail) {
    try {
        const { data, error } = await resend.emails.send({
            from: `Uptime Monitor <${fromEmail}>`,
            to: [toEmail],
            subject: `🚨 Website Alert: ${url} is Down`,
            html: `<p>This is an automated alert. We detected that your website <strong>${url}</strong> is currently down.</p>`,
        });
        if (error) throw error;
        console.log(`Alert email sent to ${toEmail} for site ${url}.`);
    } catch (error) {
        console.error('Error sending email via Resend:', error);
    }
} 