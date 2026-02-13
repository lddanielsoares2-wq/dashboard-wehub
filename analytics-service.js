/**
 * Analytics Service - Proxy to Python Analytics Service
 * Handles communication with the Manus AI-powered analytics engine
 */

const axios = require('axios');

const ANALYTICS_SERVICE_URL = process.env.ANALYTICS_SERVICE_URL || 'http://localhost:8001';

// Create axios instance with default config
const analyticsClient = axios.create({
    baseURL: ANALYTICS_SERVICE_URL,
    timeout: 60000, // 60 seconds timeout for AI operations
    headers: {
        'Content-Type': 'application/json'
    }
});

/**
 * Get analytics data (aggregated metrics)
 */
async function getAnalyticsData() {
    try {
        const response = await analyticsClient.get('/api/analytics/data');
        return response.data;
    } catch (error) {
        console.error('Error fetching analytics data:', error.message);
        return {
            success: false,
            error: error.message || 'Failed to fetch analytics data'
        };
    }
}

/**
 * Get AI-generated insights
 */
async function getInsights(startDate, endDate, metricType = 'all') {
    try {
        const response = await analyticsClient.post('/api/analytics/insights', {
            start_date: startDate,
            end_date: endDate,
            metric_type: metricType
        });
        return response.data;
    } catch (error) {
        console.error('Error fetching insights:', error.message);
        return {
            success: false,
            insights: [],
            error: error.message || 'Failed to fetch insights'
        };
    }
}

/**
 * Chat with AI about metrics
 */
async function chatWithAI(message, context = null, history = []) {
    try {
        const response = await analyticsClient.post('/api/analytics/chat', {
            message,
            context,
            history
        });
        return response.data;
    } catch (error) {
        console.error('Error in AI chat:', error.message);
        return {
            success: false,
            message: '',
            error: error.message || 'Failed to process chat message'
        };
    }
}

/**
 * Generate SEO-optimized blog post
 */
async function generatePost(blogDomain, category, keyword, tone, size, customPrompt = null) {
    try {
        const response = await analyticsClient.post('/api/automation/generate', {
            blog_domain: blogDomain,
            category,
            keyword,
            tone,
            size,
            custom_prompt: customPrompt
        });
        return response.data;
    } catch (error) {
        console.error('Error generating post:', error.message);
        return {
            success: false,
            error: error.message || 'Failed to generate post'
        };
    }
}

/**
 * Get task status
 */
async function getTaskStatus(taskId) {
    try {
        const response = await analyticsClient.get(`/api/automation/task/${taskId}`);
        return response.data;
    } catch (error) {
        console.error('Error fetching task status:', error.message);
        return {
            success: false,
            status: 'error',
            error: error.message || 'Failed to fetch task status'
        };
    }
}

/**
 * Get available domains for automation
 */
async function getAvailableDomains() {
    try {
        const response = await analyticsClient.get('/api/automation/domains');
        return response.data;
    } catch (error) {
        console.error('Error fetching domains:', error.message);
        return {
            success: false,
            domains: [],
            error: error.message || 'Failed to fetch domains'
        };
    }
}

/**
 * Get available categories
 */
async function getAvailableCategories() {
    try {
        const response = await analyticsClient.get('/api/automation/categories');
        return response.data;
    } catch (error) {
        console.error('Error fetching categories:', error.message);
        return {
            success: false,
            categories: [],
            error: error.message || 'Failed to fetch categories'
        };
    }
}

/**
 * Health check for analytics service
 */
async function healthCheck() {
    try {
        const response = await analyticsClient.get('/health');
        return {
            success: true,
            status: response.data.status,
            service: 'analytics'
        };
    } catch (error) {
        return {
            success: false,
            status: 'unavailable',
            error: error.message || 'Analytics service is unavailable'
        };
    }
}

module.exports = {
    getAnalyticsData,
    getInsights,
    chatWithAI,
    generatePost,
    getTaskStatus,
    getAvailableDomains,
    getAvailableCategories,
    healthCheck
};
