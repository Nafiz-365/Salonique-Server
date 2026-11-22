import express from "express";
import { MongoClient, ObjectId } from "mongodb";
import cors from "cors";
import "dotenv/config";
import { createRemoteJWKSet, jwtVerify } from "jose";
import Stripe from "stripe";

const app = express();
const PORT = process.env.PORT || 8000;
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:3000";
const ALLOW_DEV_AUTH_FALLBACK =
    process.env.NODE_ENV !== "production" &&
    process.env.ALLOW_DEV_AUTH_FALLBACK === "true";

// Initialize Stripe (if STRIPE_SECRET_KEY is provided)
const stripe = process.env.STRIPE_SECRET_KEY
    ? new Stripe(process.env.STRIPE_SECRET_KEY)
    : null;

// CORS
app.use(
    cors({
        origin: ["http://localhost:3000", CLIENT_URL],
        credentials: true,
    }),
);

// MongoDB Connection
let client = null;
let db = null;
let servicesCollection = null;
let appointmentsCollection = null;
let usersCollection = null;
let transactionsCollection = null;

async function initMongoDB() {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
        console.warn(
            "MONGODB_URI not provided in .env yet. Running in standby mode.",
        );
        return false;
    }
    try {
        client = new MongoClient(uri);
        await client.connect();
        console.log("Connected to Salonique MongoDB successfully!");
        db = client.db("salonique");

        servicesCollection = db.collection("services");
        appointmentsCollection = db.collection("appointments");
        usersCollection = db.collection("user"); // Better Auth uses 'user' collection
        transactionsCollection = db.collection("transactions");

        // Indexes
        await Promise.all([
            servicesCollection.createIndex({ category: 1, price: 1 }),
            servicesCollection.createIndex({ slug: 1 }),
            appointmentsCollection.createIndex({
                serviceId: 1,
                date: 1,
                time: 1,
                status: 1,
            }),
            appointmentsCollection.createIndex(
                { serviceId: 1, date: 1, time: 1 },
                {
                    name: "unique_active_appointment_slot",
                    unique: true,
                    partialFilterExpression: { activeSlot: true },
                },
            ),
            appointmentsCollection.createIndex({ userEmail: 1, createdAt: -1 }),
            transactionsCollection.createIndex({ appointmentId: 1 }),
        ]);

        return true;
    } catch (err) {
        console.error("MongoDB connection warning:", err.message);
        return false;
    }
}

const mongoInitialization = initMongoDB();

// ─── Stripe Webhook Route (RAW BODY PARSER) ──────────────────────────────────
// Must be registered before express.json()
app.post(
    "/webhook",
    express.raw({ type: "application/json" }),
    async (req, res) => {
        const sig = req.headers["stripe-signature"];
        const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
        let event;

        if (!stripe || !webhookSecret) {
            return res.status(503).json({
                error: "Stripe webhook is not configured.",
            });
        }
        if (!sig) {
            return res.status(400).json({
                error: "Missing Stripe signature.",
            });
        }
        try {
            event = stripe.webhooks.constructEvent(
                req.body,
                sig,
                webhookSecret,
            );
        } catch (err) {
            console.error(
                "Webhook signature verification failed:",
                err.message,
            );
            return res.status(400).send(`Webhook Error: ${err.message}`);
        }

        if (
            event.type === "checkout.session.expired" ||
            event.type === "checkout.session.async_payment_failed"
        ) {
            const session = event.data.object;
            const appointmentId = session.metadata?.appointmentId;
            if (appointmentId && appointmentsCollection) {
                const filter = ObjectId.isValid(appointmentId)
                    ? { _id: new ObjectId(appointmentId) }
                    : { id: appointmentId };
                const appointment = await appointmentsCollection.findOne({
                    ...filter,
                    stripeSessionId: session.id,
                });
                if (appointment) {
                    await appointmentsCollection.updateOne(
                        { ...filter, stripeSessionId: session.id },
                        { $unset: { stripeSessionId: "" } },
                    );

                    if (
                        event.type ===
                            "checkout.session.async_payment_failed" &&
                        transactionsCollection &&
                        !(await transactionsCollection.findOne({
                            stripeSessionId: session.id,
                        }))
                    ) {
                        const amount = Number.isFinite(session.amount_total)
                            ? session.amount_total / 100
                            : Number(appointment.servicePrice);
                        const now = new Date().toISOString();
                        await transactionsCollection.insertOne({
                            appointmentId,
                            appointmentDate: appointment.date || "",
                            customerId:
                                appointment.customerId ||
                                session.metadata?.userEmail ||
                                "customer",
                            customerName: appointment.userName || "Customer",
                            customerEmail: appointment.userEmail || "",
                            serviceName:
                                appointment.serviceName || "Salon Treatment",
                            amount,
                            currency: session.currency?.toUpperCase() || "USD",
                            stripeSessionId: session.id,
                            status: "failed",
                            createdAt: now,
                            date: now.split("T")[0],
                        });
                    }
                }
            }
        }

        if (
            event.type === "checkout.session.completed" ||
            event.type === "checkout.session.async_payment_succeeded"
        ) {
            const session = event.data.object;
            const appointmentId = session.metadata?.appointmentId;
            if (
                session.payment_status === "paid" &&
                appointmentId &&
                appointmentsCollection
            ) {
                const filter = ObjectId.isValid(appointmentId)
                    ? { _id: new ObjectId(appointmentId) }
                    : { id: appointmentId };
                const appointment =
                    await appointmentsCollection.findOne(filter);
                const expectedAmount = Math.round(
                    Number(appointment?.servicePrice) * 100,
                );
                const sessionEmail = session.metadata?.userEmail?.toLowerCase();

                if (
                    !appointment ||
                    !sessionEmail ||
                    sessionEmail !== appointment.userEmail?.toLowerCase() ||
                    !Number.isFinite(expectedAmount) ||
                    session.amount_total !== expectedAmount ||
                    session.currency !== "usd"
                ) {
                    console.error(
                        `Ignoring paid Checkout Session ${session.id}: appointment, customer, amount, or currency did not match.`,
                    );
                } else {
                    await appointmentsCollection.updateOne(filter, {
                        $set: {
                            paymentStatus: "paid",
                            stripeSessionId: session.id,
                            paidAt: new Date().toISOString(),
                        },
                    });

                    if (
                        transactionsCollection &&
                        !(await transactionsCollection.findOne({
                            stripeSessionId: session.id,
                        }))
                    ) {
                        const amount = session.amount_total / 100;
                        await transactionsCollection.insertOne({
                            appointmentId,
                            appointmentDate: appointment.date || "",
                            customerId:
                                appointment.customerId ||
                                session.metadata?.userEmail ||
                                "customer",
                            customerName:
                                appointment.userName ||
                                session.metadata?.userName ||
                                "Customer",
                            customerEmail:
                                appointment.userEmail ||
                                session.metadata?.userEmail ||
                                "",
                            serviceName:
                                appointment.serviceName ||
                                session.metadata?.serviceName ||
                                "Salon Treatment",
                            amount,
                            currency: session.currency?.toUpperCase() || "USD",
                            stripeSessionId: session.id,
                            status: "paid",
                            createdAt: new Date().toISOString(),
                            date: new Date().toISOString().split("T")[0],
                        });
                    }
                }
            }
        }

        res.json({ received: true });
    },
);

// Standard JSON body parser for all other routes
app.use(express.json({ limit: "10mb" }));

// ─── JWT Authentication Verification Middleware ──────────────────────────────
export const verifyToken = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        if (ALLOW_DEV_AUTH_FALLBACK && req.headers["x-user-email"]) {
            const devEmail = req.headers["x-user-email"];
            req.user = {
                email: devEmail,
                name: "User",
                role: "customer",
            };
            return checkBlockedUser(req, res, next);
        }
        return res
            .status(401)
            .json({ error: "Unauthorized: Missing authorization header." });
    }

    const token = authHeader.split(" ")[1];
    if (!token) {
        return res.status(401).json({ error: "Unauthorized: Token missing." });
    }

    try {
        const JWKS = createRemoteJWKSet(new URL(`${CLIENT_URL}/api/auth/jwks`));
        const { payload } = await jwtVerify(token, JWKS);
        if (typeof payload.email !== "string" || !payload.email.trim()) {
            return res.status(401).json({
                error: "Unauthorized: Token has no valid user email.",
            });
        }
        req.user = payload;
        return checkBlockedUser(req, res, next);
    } catch {
        if (ALLOW_DEV_AUTH_FALLBACK) {
            const devEmail = req.headers["x-user-email"] || "user@example.com";
            req.user = {
                email: devEmail,
                name: "User",
                role: "customer",
            };
            return checkBlockedUser(req, res, next);
        }
        return res
            .status(401)
            .json({ error: "Unauthorized: Invalid or expired token." });
    }
};

// Check if authenticated user is blocked
async function checkBlockedUser(req, res, next) {
    if (!usersCollection) {
        return res.status(503).json({
            error: "User access cannot be verified while the database is unavailable.",
        });
    }
    try {
        const dbUser = await usersCollection.findOne({
            email: req.user.email.toLowerCase(),
        });
        if (dbUser?.isBlocked || dbUser?.status === "suspended") {
            return res.status(403).json({
                error: "Account Blocked: Access to protected platform features has been restricted.",
            });
        }
        return next();
    } catch (err) {
        console.error("Blocked-user check failed:", err.message);
        return res.status(503).json({
            error: "User access could not be verified. Please try again.",
        });
    }
}

// ─── Admin Role Verification Middleware ──────────────────────────────────────
export const verifyAdmin = (req, res, next) => {
    if (!req.user || req.user.role !== "admin") {
        return res.status(403).json({
            error: "Forbidden: Administrator permissions required.",
        });
    }
    next();
};

// ─── Public Routes ───────────────────────────────────────────────────────────

// Root Health Check
app.get("/", (req, res) => {
    res.json({
        name: "Salonique API Server",
        status: "online",
        message: "Server is healthy and running!",
        timestamp: new Date().toISOString(),
        dbConnected: !!servicesCollection,
        stripeEnabled: !!stripe,
    });
});

// GET /services - Filtered Discovery with Search & Sorting
app.get("/services", async (req, res) => {
    try {
        const {
            category,
            search,
            minPrice,
            maxPrice,
            sort,
            location,
            featured,
        } = req.query;
        const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
        const limit = Math.min(
            100,
            Math.max(1, Number.parseInt(req.query.limit, 10) || 24),
        );

        if (!servicesCollection) {
            return res.status(503).json({
                error: "Database not connected. Please configure MONGODB_URI.",
            });
        }

        const query = { isActive: true }; // Only active services visible on public browse
        if (featured === "true") {
            query.featured = true;
        }
        if (category && category !== "All") {
            query.category = category;
        }
        if (location) {
            query.location = { $regex: location, $options: "i" };
        }
        if (search) {
            const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            query.$or = [
                { name: { $regex: escaped, $options: "i" } },
                { description: { $regex: escaped, $options: "i" } },
                { shortDescription: { $regex: escaped, $options: "i" } },
                { location: { $regex: escaped, $options: "i" } },
                { "specialist.name": { $regex: escaped, $options: "i" } },
            ];
        }
        if (minPrice || maxPrice) {
            query.price = {};
            if (minPrice) query.price.$gte = Number(minPrice);
            if (maxPrice) query.price.$lte = Number(maxPrice);
        }

        let sortOption = { createdAt: -1 };
        if (sort === "price_asc") sortOption = { price: 1 };
        else if (sort === "price_desc") sortOption = { price: -1 };
        else if (sort === "rating") sortOption = { rating: -1 };
        else if (sort === "duration") sortOption = { duration: 1 };

        const total = await servicesCollection.countDocuments(query);
        const services = await servicesCollection
            .find(query)
            .sort(sortOption)
            .skip((page - 1) * limit)
            .limit(limit)
            .toArray();

        res.json({
            services,
            total,
            page,
            totalPages: Math.ceil(total / limit) || 1,
        });
    } catch (err) {
        res.status(500).json({
            error: "Failed to fetch services",
            details: err.message,
        });
    }
});

// GET /featured-services
app.get("/featured-services", async (req, res) => {
    try {
        if (!servicesCollection) {
            return res.status(503).json({ error: "Database not connected." });
        }
        const featured = await servicesCollection
            .find({ featured: true, isActive: true })
            .sort({ rating: -1 })
            .limit(6)
            .toArray();
        res.json(featured);
    } catch (err) {
        res.status(500).json({
            error: "Failed to fetch featured services",
            details: err.message,
        });
    }
});

// GET /service/:id
app.get("/service/:id", async (req, res) => {
    try {
        const { id } = req.params;
        let item = null;
        if (servicesCollection) {
            if (ObjectId.isValid(id)) {
                item = await servicesCollection.findOne({
                    _id: new ObjectId(id),
                });
            }
            if (!item) {
                item = await servicesCollection.findOne({ slug: id });
            }
        }
        if (!item) {
            return res.status(404).json({ error: "Service not found." });
        }
        res.json(item);
    } catch (err) {
        res.status(500).json({
            error: "Failed to fetch service details",
            details: err.message,
        });
    }
});

// ─── Admin Services Management ───────────────────────────────────────────────

// GET /admin/services (Protected, Admin Only)
app.get("/admin/services", verifyToken, verifyAdmin, async (req, res) => {
    try {
        if (!servicesCollection) {
            return res.status(503).json({ error: "Database not connected." });
        }

        const services = await servicesCollection
            .find()
            .sort({ createdAt: -1 })
            .toArray();
        return res.json({ services, total: services.length });
    } catch (err) {
        return res.status(500).json({
            error: "Failed to fetch admin services",
            details: err.message,
        });
    }
});

// POST /services (Protected, Admin Only)
app.post("/services", verifyToken, verifyAdmin, async (req, res) => {
    try {
        const data = req.body;
        const svcName =
            typeof data.name === "string"
                ? data.name.trim()
                : typeof data.serviceName === "string"
                  ? data.serviceName.trim()
                  : "";
        if (
            !svcName ||
            typeof data.category !== "string" ||
            !data.category.trim()
        ) {
            return res
                .status(400)
                .json({ error: "Service name and category are required." });
        }
        const price = Number(data.price);
        const duration = Number(data.duration);
        if (!Number.isFinite(price) || price <= 0) {
            return res
                .status(400)
                .json({ error: "Price must be a positive number." });
        }
        if (!Number.isFinite(duration) || duration <= 0) {
            return res
                .status(400)
                .json({ error: "Duration must be a positive number." });
        }

        const isActive =
            data.isActive !== undefined
                ? Boolean(data.isActive)
                : data.status !== "inactive";
        const newService = {
            ...data,
            name: svcName,
            serviceName: svcName,
            slug: svcName.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
            price,
            duration,
            rating: 5.0,
            reviewCount: 0,
            isActive,
            status: isActive ? "active" : "inactive",
            createdAt: new Date().toISOString(),
        };

        if (servicesCollection) {
            const result = await servicesCollection.insertOne(newService);
            return res.status(201).json({
                message: "Service created successfully!",
                insertedId: result.insertedId,
                service: { ...newService, _id: result.insertedId },
            });
        }
        return res.status(503).json({ error: "Database not connected." });
    } catch (err) {
        res.status(500).json({
            error: "Failed to create service",
            details: err.message,
        });
    }
});

// PATCH /services/:id (Protected, Admin Only)
app.patch("/services/:id", verifyToken, verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const updateData = { ...req.body, updatedAt: new Date().toISOString() };
        if (Object.hasOwn(updateData, "price")) {
            updateData.price = Number(updateData.price);
            if (!Number.isFinite(updateData.price) || updateData.price <= 0) {
                return res
                    .status(400)
                    .json({ error: "Price must be a positive number." });
            }
        }
        if (Object.hasOwn(updateData, "duration")) {
            updateData.duration = Number(updateData.duration);
            if (
                !Number.isFinite(updateData.duration) ||
                updateData.duration <= 0
            ) {
                return res
                    .status(400)
                    .json({ error: "Duration must be a positive number." });
            }
        }
        if (
            Object.hasOwn(updateData, "name") ||
            Object.hasOwn(updateData, "serviceName")
        ) {
            const name =
                typeof updateData.name === "string"
                    ? updateData.name
                    : updateData.serviceName;
            if (typeof name !== "string" || !name.trim()) {
                return res
                    .status(400)
                    .json({ error: "Service name cannot be empty." });
            }
            updateData.name = name.trim();
            updateData.serviceName = name.trim();
            updateData.slug = name
                .trim()
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-");
        }
        if (Object.hasOwn(updateData, "isActive")) {
            if (typeof updateData.isActive !== "boolean") {
                return res.status(400).json({
                    error: "Service status must be active or inactive.",
                });
            }
            updateData.status = updateData.isActive ? "active" : "inactive";
        } else if (Object.hasOwn(updateData, "status")) {
            if (!["active", "inactive"].includes(updateData.status)) {
                return res.status(400).json({
                    error: "Service status must be active or inactive.",
                });
            }
            updateData.isActive = updateData.status === "active";
        }

        if (servicesCollection) {
            const filter = ObjectId.isValid(id)
                ? { _id: new ObjectId(id) }
                : { slug: id };
            const result = await servicesCollection.updateOne(filter, {
                $set: updateData,
            });
            if (result.matchedCount === 0) {
                return res.status(404).json({ error: "Service not found." });
            }
            return res.json({
                message: "Service updated successfully!",
                modifiedCount: result.modifiedCount,
            });
        }
        return res.status(503).json({ error: "Database not connected." });
    } catch (err) {
        res.status(500).json({
            error: "Failed to update service",
            details: err.message,
        });
    }
});

// DELETE /services/:id (Protected, Admin Only)
app.delete("/services/:id", verifyToken, verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        if (servicesCollection) {
            const filter = ObjectId.isValid(id)
                ? { _id: new ObjectId(id) }
                : { slug: id };
            const service = await servicesCollection.findOne(filter);
            if (!service) {
                return res.status(404).json({ error: "Service not found." });
            }
            if (appointmentsCollection) {
                const activeBookings =
                    await appointmentsCollection.countDocuments({
                        serviceId: service._id.toString(),
                        status: { $in: ["pending", "confirmed"] },
                        paymentStatus: { $ne: "paid" },
                    });
                if (activeBookings > 0) {
                    return res.status(409).json({
                        error: "Cancel pending or confirmed unpaid appointments before deleting this service.",
                    });
                }
            }
            const result = await servicesCollection.deleteOne(filter);
            return res.json({
                message: "Service removed successfully!",
                deletedCount: result.deletedCount,
            });
        }
        return res.status(503).json({ error: "Database not connected." });
    } catch (err) {
        res.status(500).json({
            error: "Failed to delete service",
            details: err.message,
        });
    }
});

// ─── Appointment Booking System ──────────────────────────────────────────────

// POST /booking (Protected, Customer Only)
app.post("/booking", verifyToken, async (req, res) => {
    try {
        if (req.user?.role !== "customer") {
            return res.status(403).json({
                error: "Only customer accounts can submit appointment requests.",
            });
        }

        const { serviceId, date, time } = req.body;
        if (
            typeof serviceId !== "string" ||
            !serviceId.trim() ||
            typeof date !== "string" ||
            typeof time !== "string" ||
            !time.trim()
        ) {
            return res.status(400).json({
                error: "Missing required booking details (serviceId, date, time).",
            });
        }

        if (!servicesCollection || !appointmentsCollection) {
            return res.status(503).json({ error: "Database not connected." });
        }

        const normalizedServiceId = serviceId.trim();
        const svcFilter = ObjectId.isValid(normalizedServiceId)
            ? { _id: new ObjectId(normalizedServiceId) }
            : { slug: normalizedServiceId };
        const service = await servicesCollection.findOne(svcFilter);
        if (!service) {
            return res.status(404).json({ error: "Service not found." });
        }
        if (service.isActive === false) {
            return res.status(400).json({
                error: "This service is inactive and cannot be booked.",
            });
        }

        const servicePrice = Number(service.price);
        const serviceDuration = Number(service.duration);
        if (
            !Number.isFinite(servicePrice) ||
            servicePrice <= 0 ||
            !Number.isFinite(serviceDuration) ||
            serviceDuration <= 0
        ) {
            return res.status(400).json({
                error: "This service is not configured for booking.",
            });
        }

        const parsedDate = new Date(`${date}T00:00:00.000Z`);
        if (
            !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
            Number.isNaN(parsedDate.getTime()) ||
            parsedDate.toISOString().slice(0, 10) !== date
        ) {
            return res.status(400).json({
                error: "Please select a valid appointment date.",
            });
        }

        // Check future date
        const today = new Date().toISOString().split("T")[0];
        if (date < today) {
            return res.status(400).json({
                error: "Please select a future date for your appointment.",
            });
        }

        // Prevent duplicate active appointments for same date and time slot
        const storedServiceId = service._id.toString();
        const collision = await appointmentsCollection.findOne({
            serviceId: storedServiceId,
            date,
            time: time.trim(),
            status: { $in: ["confirmed", "pending"] },
        });

        if (collision) {
            return res.status(409).json({
                error: "Double-booking collision detected.",
                message: `This time slot (${time} on ${date}) is already reserved. Please select another slot.`,
            });
        }

        const userEmail = req.user.email.toLowerCase();
        const userName =
            (typeof req.user.name === "string" && req.user.name.trim()) ||
            (typeof req.body.userName === "string" &&
                req.body.userName.trim()) ||
            "Customer";
        const message =
            typeof req.body.notes === "string"
                ? req.body.notes.trim()
                : typeof req.body.message === "string"
                  ? req.body.message.trim()
                  : "";
        const specialist =
            service.specialist &&
            typeof service.specialist === "object" &&
            typeof service.specialist.name === "string"
                ? service.specialist.name
                : typeof service.specialistName === "string"
                  ? service.specialistName
                  : "Salon Specialist";
        const customerId = req.user.sub || req.user.id || userEmail;
        const newAppointment = {
            customerId,
            userId: customerId,
            userEmail,
            userName,
            userPhone:
                typeof req.body.userPhone === "string"
                    ? req.body.userPhone.trim()
                    : "",
            serviceId: storedServiceId,
            serviceName: service.name,
            serviceCategory: service.category || "",
            servicePrice,
            serviceDuration,
            serviceImage: service.image || "",
            date,
            appointmentDate: date,
            time: time.trim(),
            timeSlot: time.trim(),
            specialist,
            location: service.location || "",
            message,
            notes: message,
            status: "pending",
            paymentStatus: "unpaid",
            activeSlot: true,
            createdAt: new Date().toISOString(),
        };

        const result = await appointmentsCollection.insertOne(newAppointment);
        return res.status(201).json({
            message: "Appointment request submitted successfully!",
            insertedId: result.insertedId,
            appointment: { ...newAppointment, _id: result.insertedId },
        });
    } catch (err) {
        if (err.code === 11000) {
            return res.status(409).json({
                error: "This time slot has already been reserved. Please select another time.",
            });
        }
        res.status(500).json({
            error: "Failed to reserve appointment",
            details: err.message,
        });
    }
});

// GET /my-appointments/:email (Protected, Customer)
app.get("/my-appointments/:email", verifyToken, async (req, res) => {
    try {
        const { email } = req.params;
        if (
            req.user?.email &&
            req.user.email.toLowerCase() !== email.toLowerCase()
        ) {
            return res
                .status(403)
                .json({ error: "You can only view your own appointments." });
        }

        if (appointmentsCollection) {
            const list = await appointmentsCollection
                .find({ userEmail: email.toLowerCase() })
                .sort({ createdAt: -1 })
                .toArray();
            return res.json({ appointments: list });
        }
        return res.status(503).json({ error: "Database not connected." });
    } catch (err) {
        res.status(500).json({
            error: "Failed to fetch appointments",
            details: err.message,
        });
    }
});

// GET /all-appointments (Protected, Admin Only)
app.get("/all-appointments", verifyToken, verifyAdmin, async (req, res) => {
    try {
        if (appointmentsCollection) {
            const list = await appointmentsCollection
                .find()
                .sort({ createdAt: -1 })
                .toArray();
            return res.json({ appointments: list });
        }
        return res.status(503).json({ error: "Database not connected." });
    } catch (err) {
        res.status(500).json({
            error: "Failed to fetch appointments",
            details: err.message,
        });
    }
});

// PATCH /appointment/:id/status (Protected, Admin Only)
app.patch(
    "/appointment/:id/status",
    verifyToken,
    verifyAdmin,
    async (req, res) => {
        try {
            const { id } = req.params;
            const { status } = req.body;
            if (!["pending", "confirmed", "cancelled"].includes(status)) {
                return res.status(400).json({ error: "Invalid status value." });
            }

            if (appointmentsCollection) {
                const filter = ObjectId.isValid(id)
                    ? { _id: new ObjectId(id) }
                    : { id };
                const current = await appointmentsCollection.findOne(filter);
                if (!current) {
                    return res
                        .status(404)
                        .json({ error: "Appointment not found." });
                }

                // Rule: Only pending appointments can be confirmed
                if (status === "confirmed" && current.status !== "pending") {
                    return res.status(400).json({
                        error: "Only pending appointments can be confirmed.",
                    });
                }
                if (
                    status === "cancelled" &&
                    !["pending", "confirmed"].includes(current.status)
                ) {
                    return res.status(400).json({
                        error: "Only pending or confirmed appointments can be cancelled.",
                    });
                }
                if (status === "pending" && current.status !== "pending") {
                    return res.status(400).json({
                        error: "Appointments cannot be moved back to pending.",
                    });
                }

                const update = {
                    status,
                    updatedAt: new Date().toISOString(),
                };
                if (status === "cancelled") update.activeSlot = false;
                const result = await appointmentsCollection.updateOne(filter, {
                    $set: update,
                });
                return res.json({
                    message: `Appointment status updated to ${status}`,
                    modifiedCount: result.modifiedCount,
                });
            }
            return res.status(503).json({ error: "Database not connected." });
        } catch (err) {
            res.status(500).json({
                error: "Failed to update appointment",
                details: err.message,
            });
        }
    },
);

// PATCH /appointment/:id/cancel (Protected)
app.patch("/appointment/:id/cancel", verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const filter = ObjectId.isValid(id)
            ? { _id: new ObjectId(id) }
            : { id };

        if (appointmentsCollection) {
            const apt = await appointmentsCollection.findOne(filter);
            if (!apt)
                return res
                    .status(404)
                    .json({ error: "Appointment not found." });

            // Customer can cancel only their own pending appointment
            if (req.user?.role === "admin") {
                if (!["pending", "confirmed"].includes(apt.status)) {
                    return res.status(400).json({
                        error: "Only pending or confirmed appointments can be cancelled.",
                    });
                }
            } else {
                if (
                    apt.userEmail?.toLowerCase() !==
                    req.user.email.toLowerCase()
                ) {
                    return res.status(403).json({
                        error: "You can only cancel your own appointments.",
                    });
                }
                if (apt.status !== "pending") {
                    return res.status(400).json({
                        error: "Customers can only cancel pending appointment requests.",
                    });
                }
            }

            await appointmentsCollection.updateOne(filter, {
                $set: {
                    status: "cancelled",
                    activeSlot: false,
                    cancelledAt: new Date().toISOString(),
                },
            });
            return res.json({ message: "Appointment cancelled successfully." });
        }
        return res.status(503).json({ error: "Database not connected." });
    } catch (err) {
        res.status(500).json({
            error: "Failed to cancel appointment",
            details: err.message,
        });
    }
});

// ─── Stripe Payment Integration ──────────────────────────────────────────────

// POST /create-checkout-session (Protected, Customer)
app.post("/create-checkout-session", verifyToken, async (req, res) => {
    try {
        const { appointmentId } = req.body;
        if (typeof appointmentId !== "string" || !appointmentId.trim()) {
            return res
                .status(400)
                .json({ error: "appointmentId is required." });
        }

        if (!appointmentsCollection) {
            return res.status(503).json({ error: "Database not connected." });
        }

        const normalizedAppointmentId = appointmentId.trim();
        const filter = ObjectId.isValid(normalizedAppointmentId)
            ? { _id: new ObjectId(normalizedAppointmentId) }
            : { id: normalizedAppointmentId };

        const apt = await appointmentsCollection.findOne(filter);
        if (!apt) {
            return res.status(404).json({ error: "Appointment not found." });
        }
        if (req.user?.role !== "customer") {
            return res.status(403).json({
                error: "Only customer accounts can pay for appointments.",
            });
        }
        if (apt.userEmail?.toLowerCase() !== req.user?.email?.toLowerCase()) {
            return res.status(403).json({
                error: "You can only pay for your own appointments.",
            });
        }

        // Rules: Customers cannot pay for cancelled or pending appointments
        if (apt.status !== "confirmed") {
            return res.status(400).json({
                error: "Only confirmed appointments can be paid. Please wait for salon confirmation.",
            });
        }

        if (apt.paymentStatus === "paid") {
            return res
                .status(400)
                .json({ error: "This appointment has already been paid." });
        }

        if (!servicesCollection) {
            return res.status(503).json({ error: "Database not connected." });
        }
        if (!stripe) {
            return res.status(503).json({
                error: "Stripe is not configured. Online checkout is unavailable.",
            });
        }

        const serviceId = String(apt.serviceId || "");
        const serviceFilter = ObjectId.isValid(serviceId)
            ? { _id: new ObjectId(serviceId) }
            : { slug: serviceId };
        const service = await servicesCollection.findOne(serviceFilter);
        if (!service) {
            return res.status(409).json({
                error: "The service for this appointment is no longer available.",
            });
        }
        const servicePrice = Number(service.price);
        const amountInCents = Math.round(servicePrice * 100);
        const appointmentAmountInCents = Math.round(
            Number(apt.servicePrice) * 100,
        );
        if (
            !Number.isFinite(servicePrice) ||
            amountInCents <= 0 ||
            !Number.isFinite(appointmentAmountInCents)
        ) {
            return res.status(400).json({
                error: "This appointment has an invalid payment amount.",
            });
        }
        if (appointmentAmountInCents !== amountInCents) {
            if (apt.stripeSessionId) {
                const previousSession = await stripe.checkout.sessions.retrieve(
                    apt.stripeSessionId,
                );
                if (previousSession.status === "complete") {
                    return res.status(409).json({
                        error: "Payment is already processing for this appointment.",
                    });
                }
                if (previousSession.status === "open") {
                    await stripe.checkout.sessions.expire(previousSession.id);
                }
            }
            await appointmentsCollection.updateOne(filter, {
                $set: { servicePrice },
                $unset: { stripeSessionId: "" },
            });
            return res.status(409).json({
                error: "The service price changed. Refresh the appointments page to review the updated price before paying.",
            });
        }

        if (apt.stripeSessionId) {
            const existingSession = await stripe.checkout.sessions.retrieve(
                apt.stripeSessionId,
            );
            if (existingSession.status === "open" && existingSession.url) {
                return res.json({
                    url: existingSession.url,
                    sessionId: existingSession.id,
                });
            }
            if (existingSession.status === "complete") {
                return res.status(409).json({
                    error: "Payment is already processing for this appointment.",
                });
            }
        }

        // Ensure valid public image URL if provided
        const validImages =
            apt.serviceImage && apt.serviceImage.startsWith("http")
                ? [apt.serviceImage]
                : [];

        const session = await stripe.checkout.sessions.create({
            mode: "payment",
            line_items: [
                {
                    price_data: {
                        currency: "usd",
                        product_data: {
                            name: apt.serviceName,
                            description: `Appointment with ${apt.specialist} on ${apt.date} at ${apt.time}`,
                            images: validImages,
                        },
                        unit_amount: amountInCents,
                    },
                    quantity: 1,
                },
            ],
            client_reference_id: apt._id.toString(),
            customer_email: apt.userEmail,
            metadata: {
                appointmentId: apt._id.toString(),
                userEmail: apt.userEmail,
                userName: apt.userName,
                serviceName: apt.serviceName,
            },
            success_url: `${CLIENT_URL}/checkout/success?aptId=${apt._id}`,
            cancel_url: `${CLIENT_URL}/checkout/cancel?aptId=${apt._id}`,
        });

        if (!session.url) {
            return res.status(502).json({
                error: "Stripe did not return a Checkout URL.",
            });
        }

        await appointmentsCollection.updateOne(filter, {
            $set: { stripeSessionId: session.id },
        });

        res.json({ url: session.url, sessionId: session.id });
    } catch (err) {
        res.status(500).json({
            error: "Failed to create Stripe session",
            details: err.message,
        });
    }
});

// ─── Transactions & Users (Admin Only) ───────────────────────────────────────

// GET /transactions (Protected, Admin Only)
app.get("/transactions", verifyToken, verifyAdmin, async (req, res) => {
    try {
        if (transactionsCollection) {
            const txns = await transactionsCollection
                .find()
                .sort({ createdAt: -1 })
                .toArray();
            return res.json({ transactions: txns });
        }
        return res.status(503).json({ error: "Database not connected." });
    } catch (err) {
        res.status(500).json({
            error: "Failed to fetch transactions",
            details: err.message,
        });
    }
});

// GET /users (Protected, Admin Only)
app.get("/users", verifyToken, verifyAdmin, async (req, res) => {
    try {
        let list = [];
        if (usersCollection) {
            list = await usersCollection
                .find({ role: { $ne: "admin" } })
                .sort({ createdAt: -1 })
                .toArray();
        }
        const formatted = await Promise.all(
            list.map(async (u) => {
                let bookingCount = 0;
                let lastBooking = u.createdAt || new Date().toISOString();
                if (appointmentsCollection && u.email) {
                    bookingCount = await appointmentsCollection.countDocuments({
                        userEmail: u.email.toLowerCase(),
                    });
                    const lastApt = await appointmentsCollection
                        .find({ userEmail: u.email.toLowerCase() })
                        .sort({ createdAt: -1 })
                        .limit(1)
                        .toArray();
                    if (lastApt.length > 0 && lastApt[0].createdAt) {
                        lastBooking = lastApt[0].createdAt;
                    }
                }
                return {
                    id: u._id.toString(),
                    name: u.name,
                    email: u.email,
                    phone: u.phone || "",
                    role: u.role || "customer",
                    isBlocked: Boolean(u.isBlocked),
                    bookingCount,
                    lastBooking,
                };
            }),
        );

        res.json({ users: formatted });
    } catch (err) {
        res.status(500).json({
            error: "Failed to fetch registered users",
            details: err.message,
        });
    }
});

// PATCH /user/:email/toggle-block (Protected, Admin Only)
app.patch(
    "/user/:email/toggle-block",
    verifyToken,
    verifyAdmin,
    async (req, res) => {
        try {
            const { email } = req.params;
            const { isBlocked } = req.body;

            if (usersCollection) {
                await usersCollection.updateOne(
                    { email: decodeURIComponent(email).toLowerCase() },
                    {
                        $set: {
                            isBlocked: Boolean(isBlocked),
                            updatedAt: new Date().toISOString(),
                        },
                    },
                );
            }
            res.json({
                message: `User status updated to ${isBlocked ? "BLOCKED" : "ACTIVE"}`,
            });
        } catch (err) {
            res.status(500).json({
                error: "Failed to update user block status",
                details: err.message,
            });
        }
    },
);

// GET /verify-session/:sessionId (Read-only status check)
app.get("/verify-session/:sessionId", verifyToken, async (req, res) => {
    try {
        const { sessionId } = req.params;
        if (!stripe) {
            return res.status(400).json({ error: "Stripe not configured." });
        }
        const session = await stripe.checkout.sessions.retrieve(sessionId);
        const sessionEmail = session.metadata?.userEmail?.toLowerCase();
        if (sessionEmail !== req.user?.email?.toLowerCase()) {
            return res.status(403).json({
                error: "You can only verify your own checkout session.",
            });
        }
        return res.json({
            verified: session.payment_status === "paid",
            status: session.payment_status,
        });
    } catch (err) {
        res.status(500).json({
            error: "Failed to verify session",
            details: err.message,
        });
    }
});

// Start accepting requests only after database indexes are ready.
mongoInitialization
    .then(() => {
        app.listen(PORT, () => {
            console.log(
                `Salonique API Server running at http://localhost:${PORT}`,
            );
        });
    })
    .catch((err) => {
        console.error("Failed to initialize the API server:", err);
        process.exitCode = 1;
    });
