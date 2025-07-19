const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');
const { Resend } = require('resend');

// Production-ready scheduled website monitoring
exports.handler = async function(event, context) {
    console.log('🚀 Starting scheduled website monitoring job');
    
    // Handle CORS for manual triggers
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    };

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }

    // --- CONFIGURATION ---
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
    const RESEND_API_KEY = process.env.RESEND_API_KEY;
    const FROM_EMAIL = process.env.FROM_EMAIL;

    // Validate environment variables
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
        console.error('❌ Missing required environment variables');
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Server configuration error' })
        };
    }

    // Initialize clients
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

    try {
        // Get all websites that need checking
        const { data: websites, error: websitesError } = await supabase
            .from('websites')
            .select('*');
        
        if (websitesError) {
            console.error('❌ Error fetching websites:', websitesError);
            throw websitesError;
        }
        
        if (!websites || websites.length === 0) {
            console.log('ℹ️ No websites to check');
            return { 
                statusCode: 200, 
                headers,
                body: JSON.stringify({ message: 'No websites to check' })
            };
        }

        console.log(`📊 Checking ${websites.length} websites...`);

        // Process each website
        const results = [];
        for (const website of websites) {
            const result = await checkSingleWebsite(website, supabase, resend, FROM_EMAIL);
            results.push(result);
            
            // Small delay between checks to be respectful
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        const summary = {
            total: websites.length,
            up: results.filter(r => r.status === 'Up').length,
            down: results.filter(r => r.status === 'Down').length,
            errors: results.filter(r => r.error).length
        };

        console.log(`✅ Monitoring job completed:`, summary);
        
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                success: true,
                message: 'Monitoring job completed successfully',
                summary,
                results
            })
        };

    } catch (error) {
        console.error('❌ Error in scheduled monitoring job:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ 
                error: 'Monitoring job failed',
                details: error.message 
            })
        };
    }
};

async function checkSingleWebsite(website, supabase, resend, fromEmail) {
    const startTime = Date.now();
    let newStatus = 'Down';
    let errorMessage = '';
    let responseTime = null;

    try {
        console.log(`🔍 Checking ${website.url}...`);

        // Method 1: Try HEAD request first (faster)
        try {
            const headResponse = await fetch(website.url, { 
                method: 'HEAD',
                timeout: 10000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; UptimeMonitor/1.0)'
                }
            });
            
            responseTime = Date.now() - startTime;
            
            if (headResponse.ok) {
                newStatus = 'Up';
                console.log(`✅ ${website.url} is UP (${responseTime}ms)`);
            } else {
                console.log(`⚠️ ${website.url} HEAD failed: ${headResponse.status}`);
                
                // Method 2: Try GET request if HEAD fails
                const getResponse = await fetch(website.url, { 
                    method: 'GET',
                    timeout: 15000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (compatible; UptimeMonitor/1.0)'
                    }
                });
                
                responseTime = Date.now() - startTime;
                
                if (getResponse.ok) {
                    newStatus = 'Up';
                    console.log(`✅ ${website.url} is UP via GET (${responseTime}ms)`);
                } else {
                    errorMessage = `HTTP ${getResponse.status}: ${getResponse.statusText}`;
                    console.log(`❌ ${website.url} is DOWN: ${errorMessage}`);
                }
            }
        } catch (fetchError) {
            responseTime = Date.now() - startTime;
            errorMessage = fetchError.message;
            console.log(`❌ ${website.url} is DOWN: ${errorMessage}`);
        }

        // Check if status changed
        const statusChanged = newStatus !== website.status;
        
        // Update database
        const { error: updateError } = await supabase
            .from('websites')
            .update({ 
                status: newStatus, 
                last_checked: new Date().toISOString(),
                response_time: responseTime
            })
            .eq('id', website.id);

        if (updateError) {
            console.error(`❌ Error updating ${website.url}:`, updateError);
            return {
                url: website.url,
                status: website.status,
                error: updateError.message,
                responseTime
            };
        }

        // Send email alert if status changed to Down
        if (statusChanged && newStatus === 'Down' && resend && fromEmail) {
            try {
                // Get user email
                const { data: userData } = await supabase
                    .from('users')
                    .select('email')
                    .eq('id', website.user_id)
                    .single();

                if (userData && userData.email) {
                    await sendDownAlert(userData.email, website.url, resend, fromEmail, responseTime);
                    console.log(`📧 Alert email sent for ${website.url}`);
                }
            } catch (emailError) {
                console.error(`❌ Error sending alert email for ${website.url}:`, emailError);
            }
        }

        return {
            url: website.url,
            status: newStatus,
            previousStatus: website.status,
            statusChanged,
            responseTime,
            error: errorMessage || null
        };

    } catch (error) {
        console.error(`❌ Unexpected error checking ${website.url}:`, error);
        return {
            url: website.url,
            status: 'Down',
            error: error.message,
            responseTime: Date.now() - startTime
        };
    }
}

async function sendDownAlert(toEmail, url, resend, fromEmail, responseTime) {
    try {
        const { data, error } = await resend.emails.send({
            from: `Uptime Monitor <${fromEmail}>`,
            to: [toEmail],
            subject: `🚨 Website Alert: ${url} is Down`,
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <h2 style="color: #dc2626;">🚨 Website Down Alert</h2>
                    <p>We detected that your website is currently down:</p>
                    <div style="background: #f3f4f6; padding: 15px; border-radius: 8px; margin: 20px 0;">
                        <strong>Website:</strong> ${url}<br>
                        <strong>Detected at:</strong> ${new Date().toLocaleString()}<br>
                        <strong>Response time:</strong> ${responseTime ? responseTime + 'ms' : 'N/A'}
                    </div>
                    <p>Our monitoring system will continue to check your website and notify you when it comes back online.</p>
                    <hr style="margin: 20px 0; border: none; border-top: 1px solid #e5e7eb;">
                    <p style="color: #6b7280; font-size: 12px;">
                        This is an automated alert from your Uptime Monitor dashboard.
                    </p>
                </div>
            `,
        });
        
        if (error) throw error;
        return data;
    } catch (error) {
        console.error('Error sending email via Resend:', error);
        throw error;
    }
} 