const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');
const { Resend } = require('resend');

exports.handler = async function(event, context) {
    // Handle CORS
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
    };

    // Handle preflight requests
    if (event.httpMethod === 'OPTIONS') {
        return {
            statusCode: 200,
            headers,
            body: ''
        };
    }

    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            headers,
            body: JSON.stringify({ error: 'Method not allowed' })
        };
    }

    try {
        const { websiteId, websiteUrl } = JSON.parse(event.body);
        
        console.log(`Checking website: ${websiteUrl} (ID: ${websiteId})`);
        
        if (!websiteId || !websiteUrl) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'Missing websiteId or websiteUrl' })
            };
        }

        // Initialize Supabase client
        const SUPABASE_URL = process.env.SUPABASE_URL;
        const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
        const RESEND_API_KEY = process.env.RESEND_API_KEY;
        const FROM_EMAIL = process.env.FROM_EMAIL;
        
        if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
            console.error('Missing Supabase environment variables');
            return {
                statusCode: 500,
                headers,
                body: JSON.stringify({ error: 'Server configuration error' })
            };
        }
        
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
        const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

        // Get the previous status and user_id
        const { data: prevData, error: prevError } = await supabase
            .from('websites')
            .select('status,user_id')
            .eq('id', websiteId)
            .single();
        if (prevError || !prevData) {
            console.error('Could not fetch previous website status:', prevError);
        }
        const previousStatus = prevData ? prevData.status : null;
        const userId = prevData ? prevData.user_id : null;

        // Check the website with multiple methods
        let newStatus = 'Down';
        let errorMessage = '';
        
        try {
            // Method 1: Try HEAD request first
            const headResponse = await fetch(websiteUrl, { 
                method: 'HEAD',
                timeout: 10000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; UptimeMonitor/1.0)'
                }
            });
            
            if (headResponse.ok) {
                newStatus = 'Up';
                console.log(`HEAD request successful for ${websiteUrl}`);
            } else {
                // Method 2: Try GET request if HEAD fails
                console.log(`HEAD request failed for ${websiteUrl}, trying GET`);
                const getResponse = await fetch(websiteUrl, { 
                    method: 'GET',
                    timeout: 10000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (compatible; UptimeMonitor/1.0)'
                    }
                });
                
                if (getResponse.ok) {
                    newStatus = 'Up';
                    console.log(`GET request successful for ${websiteUrl}`);
                } else {
                    errorMessage = `HTTP ${getResponse.status}: ${getResponse.statusText}`;
                    console.log(`GET request failed for ${websiteUrl}: ${errorMessage}`);
                }
            }
        } catch (fetchError) {
            errorMessage = fetchError.message;
            console.error(`Fetch error for ${websiteUrl}:`, fetchError.message);
        }

        console.log(`Final status for ${websiteUrl}: ${newStatus}`);

        // Update the database
        const { error: updateError } = await supabase
            .from('websites')
            .update({ 
                status: newStatus, 
                last_checked: new Date().toISOString() 
            })
            .eq('id', websiteId);

        if (updateError) {
            console.error(`Error updating status for ${websiteUrl}:`, updateError);
            return {
                statusCode: 500,
                headers,
                body: JSON.stringify({ 
                    error: 'Failed to update database',
                    details: updateError.message 
                })
            };
        }

        // Send immediate email alert if status changed from Up to Down
        if (previousStatus === 'Up' && newStatus === 'Down' && resend && userId && FROM_EMAIL) {
            // Get user email
            const { data: userData, error: userError } = await supabase
                .from('users')
                .select('email')
                .eq('id', userId)
                .single();
            if (!userError && userData && userData.email) {
                try {
                    await resend.emails.send({
                        from: `Uptime Monitor <${FROM_EMAIL}>`,
                        to: [userData.email],
                        subject: `🚨 Website Alert: ${websiteUrl} is Down`,
                        html: `<p>This is an automated alert. We detected that your website <strong>${websiteUrl}</strong> is currently down.</p>`
                    });
                    console.log(`Immediate alert email sent to ${userData.email} for site ${websiteUrl}.`);
                } catch (emailError) {
                    console.error('Error sending immediate alert email:', emailError);
                }
            }
        }

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ 
                success: true, 
                status: newStatus,
                url: websiteUrl,
                checkedAt: new Date().toISOString(),
                error: errorMessage || null
            })
        };

    } catch (error) {
        console.error('Error in check-single function:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ 
                error: 'Internal server error',
                details: error.message 
            })
        };
    }
}; 