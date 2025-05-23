// server.js
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');
const path = require('path');
require('dotenv').config();
const axios = require('axios');

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('Connected to MongoDB'))
    .catch(err => console.error('MongoDB connection error:', err));

// Define Subscriber Schema
const subscriberSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    events: [{ type: String }],  // Array of event IDs
    categories: [{ type: String }],
    subscribed: { type: Boolean, default: true },
    lastEmailSent: { type: Date },
    createdAt: { type: Date, default: Date.now }
});

const Subscriber = mongoose.model('Subscriber', subscriberSchema);

// API endpoint to save subscriber
app.post('/api/subscribers', async (req, res) => {
    try {
        const { name, email, eventId, subscribe, eventUrl } = req.body;
        
        if (!name || !email || !eventId || !eventUrl) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        
        // Find or create subscriber
        let subscriber = await Subscriber.findOne({ email });
        
        if (subscriber) {
            // Update existing subscriber
            subscriber.name = name || subscriber.name;
            
            // Update subscription status if specified
            if (typeof subscribe !== 'undefined') {
                subscriber.subscribed = subscribe;
            }
            
            // Add event to subscriber's events if specified
            if (eventId && !subscriber.events.includes(eventId)) {
                subscriber.events.push(eventId);
            }
            
            await subscriber.save();
            
            // Send email notification with eventUrl
            await sendEmail(email, 'Your Event Ticket Confirmation', '', '', eventUrl);
            
            res.json({
                message: 'Subscriber updated successfully',
                subscriber: {
                    name: subscriber.name,
                    email: subscriber.email,
                    subscribed: subscriber.subscribed
                }
            });
        } else {
            // Create new subscriber
            const newSubscriber = new Subscriber({
                name,
                email,
                subscribed: subscribe !== false, // Default to true unless explicitly false
                events: eventId ? [eventId] : []
            });
            
            await newSubscriber.save();
            
            // Send confirmation email with eventUrl
            await sendEmail(email, 'Your Event Ticket Confirmation', '', '', eventUrl);
            
            res.status(201).json({
                message: 'Subscriber created successfully',
                subscriber: {
                    name: newSubscriber.name,
                    email: newSubscriber.email,
                    subscribed: newSubscriber.subscribed
                }
            });
        }
    } catch (error) {
        console.error('Error creating/updating subscriber:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// API endpoint to unsubscribe
app.put('/api/subscribers/unsubscribe/:email', async (req, res) => {
    try {
        const subscriber = await Subscriber.findOne({ email: req.params.email });
        
        if (!subscriber) {
            return res.status(404).json({ error: 'Subscriber not found' });
        }
        
        subscriber.subscribed = false;
        await subscriber.save();
        
        res.json({
            message: 'Unsubscribed successfully'
        });
    } catch (error) {
        console.error('Error unsubscribing:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Proxy endpoint for events
app.get('/api/events', async (req, res) => {
    try {
        const {
            size = 12,
            page = 0,
            segmentId,
            keyword,
            startDateTime,
            endDateTime,
            priceRange
        } = req.query;

        // Validate and sanitize inputs
        const validatedSize = Math.min(Math.max(parseInt(size) || 12, 1), 50);
        const validatedPage = Math.max(parseInt(page) || 0, 0);

        // Build Ticketmaster API URL
        const params = new URLSearchParams({
            apikey: process.env.TICKETMASTER_API_KEY,
            size: validatedSize,
            page: validatedPage + 1, // Ticketmaster uses 1-based pagination
            city: 'Sydney',
            countryCode: 'AU',
            sort: 'date,asc',
            locale: '*'
        });

        // Add optional parameters with validation
        if (segmentId) {
            // Validate segmentId format
            if (/^[A-Za-z0-9]+$/.test(segmentId)) {
                params.append('segmentId', segmentId);
            }
        }

        if (keyword) {
            // Sanitize and encode keyword
            const sanitizedKeyword = keyword.trim().replace(/[<>]/g, '');
            if (sanitizedKeyword) {
                params.append('keyword', sanitizedKeyword);
            }
        }

        if (startDateTime) {
            // Validate date format
            if (isValidISODate(startDateTime)) {
                params.append('startDateTime', startDateTime);
            }
        }

        if (endDateTime) {
            // Validate date format
            if (isValidISODate(endDateTime)) {
                params.append('endDateTime', endDateTime);
            }
        }

        if (priceRange) {
            // Validate price range format
            if (/^\d+-\d+$/.test(priceRange)) {
                params.append('priceRange', priceRange);
            }
        }

        // Add classification parameters for better filtering
        params.append('includeFamily', 'yes');
        params.append('includeTBA', 'no');
        params.append('includeTBD', 'no');

        console.log('Fetching events with params:', params.toString());

        const response = await axios.get(`https://app.ticketmaster.com/discovery/v2/events.json?${params.toString()}`);
        
        // Transform the response to match our frontend expectations
        const transformedData = {
            _embedded: {
                events: response.data._embedded.events.map(event => ({
                    ...event,
                    // Add any necessary transformations here
                }))
            },
            page: {
                size: validatedSize,
                totalElements: response.data.page.totalElements,
                totalPages: response.data.page.totalPages,
                number: validatedPage
            }
        };

        res.json(transformedData);
    } catch (error) {
        console.error('Error fetching events:', error.response?.data || error.message);
        
        // Handle specific error cases
        if (error.response) {
            switch (error.response.status) {
                case 400:
                    res.status(400).json({
                        error: 'Invalid request parameters',
                        details: error.response.data
                    });
                    break;
                case 401:
                    res.status(401).json({
                        error: 'API key is invalid or expired',
                        details: 'Please check your API key configuration'
                    });
                    break;
                case 429:
                    res.status(429).json({
                        error: 'Too many requests',
                        details: 'Please try again later'
                    });
                    break;
                default:
                    res.status(500).json({
                        error: 'Failed to fetch events',
                        details: error.response.data || error.message
                    });
            }
        } else {
            res.status(500).json({
                error: 'Failed to fetch events',
                details: error.message
            });
        }
    }
});

// Helper function to validate ISO date format
function isValidISODate(dateString) {
    const date = new Date(dateString);
    return date instanceof Date && !isNaN(date) && dateString.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
}

// Add caching middleware
const cache = new Map();
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

// Apply caching middleware to the events endpoint
app.get('/api/events', async (req, res, next) => {
    const cacheKey = req.originalUrl;
    const cachedResponse = cache.get(cacheKey);

    if (cachedResponse && Date.now() - cachedResponse.timestamp < CACHE_DURATION) {
        return res.json(cachedResponse.data);
    }

    // Store the original res.json method
    const originalJson = res.json;

    // Override res.json method
    res.json = function(data) {
        cache.set(cacheKey, {
            data,
            timestamp: Date.now()
        });
        return originalJson.call(this, data);
    };

    next();
});

// Email sending function
async function sendEmail(to, subject, text, html, eventUrl) {
    try {
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASSWORD
            }
        });

        const emailHtml = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f8fafc;">
                <div style="background-color: #ffffff; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                    <div style="text-align: center; margin-bottom: 30px;">
                        <h1 style="color: #2563eb; margin: 0; font-size: 24px;">Your Event Ticket Confirmation</h1>
                    </div>
                    
                    <div style="margin-bottom: 30px;">
                        <p style="color: #1e293b; font-size: 16px; line-height: 1.6;">
                            Thank you for your interest in the event. Your ticket information is ready!
                        </p>
                    </div>

                    <div style="background-color: #f1f5f9; padding: 20px; border-radius: 6px; margin-bottom: 30px;">
                        <h2 style="color: #1e293b; font-size: 18px; margin-top: 0;">Access Your Tickets</h2>
                        <p style="color: #64748b; margin-bottom: 20px;">
                            Click the button below to view and purchase your tickets:
                        </p>
                        <div style="text-align: center;">
                            <a href="${eventUrl}" 
                               style="background-color: #2563eb; color: white; padding: 14px 28px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: bold;">
                                View Your Tickets
                            </a>
                        </div>
                    </div>

                    <div style="border-top: 1px solid #e2e8f0; padding-top: 20px; margin-top: 30px;">
                        <p style="color: #64748b; font-size: 14px; margin-bottom: 10px;">
                            If the button above doesn't work, you can copy and paste this link into your browser:
                        </p>
                        <p style="color: #2563eb; word-break: break-all; font-size: 14px; background-color: #f1f5f9; padding: 10px; border-radius: 4px;">
                            ${eventUrl}
                        </p>
                    </div>

                    <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #e2e8f0;">
                        <p style="color: #64748b; font-size: 14px; margin: 0;">
                            Best regards,<br>
                            <strong>The Sydney Events Team</strong>
                        </p>
                    </div>
                </div>
            </div>
        `;

        const emailText = `
            Your Event Ticket Confirmation

            Thank you for your interest in the event. Your ticket information is ready!

            Access Your Tickets:
            ${eventUrl}

            If you have any questions, please don't hesitate to contact us.

            Best regards,
            The Sydney Events Team
        `;

        const mailOptions = {
            from: process.env.EMAIL_USER,
            to,
            subject: 'Your Event Ticket Confirmation - Sydney Events',
            text: emailText,
            html: emailHtml
        };

        await transporter.sendMail(mailOptions);
        console.log('Email sent successfully');
    } catch (error) {
        console.error('Error sending email:', error);
        throw new Error('Failed to send email');
    }
}

// Serve the HTML file for all routes (SPA support)
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});