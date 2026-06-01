const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const nodemailer = require('nodemailer');
const sqlite3 = require('sqlite3').verbose();
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Setup directories
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const RESUMES_DIR = path.join(UPLOADS_DIR, 'resumes');
const GALLERY_DIR = path.join(UPLOADS_DIR, 'gallery');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);
if (!fs.existsSync(RESUMES_DIR)) fs.mkdirSync(RESUMES_DIR);
if (!fs.existsSync(GALLERY_DIR)) fs.mkdirSync(GALLERY_DIR);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(UPLOADS_DIR));

// Rich Logger Middleware
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} request to ${req.url}`);
  if (Object.keys(req.body).length > 0) {
    const safeBody = { ...req.body };
    if (safeBody.password) safeBody.password = '********';
    console.log(`  Parameters:`, safeBody);
  }
  next();
});

// SQLite Database Setup
const DB_PATH = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('[SQLite Connection Error]:', err.message);
  } else {
    console.log('Connected to SQLite database.');
    initDb();
  }
});

function initDb() {
  db.serialize(() => {
    // Gallery Table
    db.run(`CREATE TABLE IF NOT EXISTS gallery (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Career Applications Table
    db.run(`CREATE TABLE IF NOT EXISTS career_applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      email TEXT NOT NULL,
      location TEXT NOT NULL,
      experience TEXT NOT NULL,
      position TEXT NOT NULL,
      resume_path TEXT NOT NULL,
      resume_name TEXT,
      resume_type TEXT,
      message TEXT,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`ALTER TABLE career_applications ADD COLUMN status TEXT DEFAULT 'pending'`, (err) => {});
    db.run(`ALTER TABLE career_applications ADD COLUMN resume_name TEXT`, (err) => {});
    db.run(`ALTER TABLE career_applications ADD COLUMN resume_type TEXT`, (err) => {});

    // Contact Inquiries Table
    db.run(`CREATE TABLE IF NOT EXISTS contact_inquiries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      email TEXT NOT NULL,
      service TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT DEFAULT 'unread',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`ALTER TABLE contact_inquiries ADD COLUMN status TEXT DEFAULT 'unread'`, (err) => {});


  });
}

// Multer Storage Configuration
const resumeStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, RESUMES_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'resume-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const galleryStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, GALLERY_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'gallery-' + uniqueSuffix + path.extname(file.originalname));
  }
});

// File Filters
const resumeFilter = (req, file, cb) => {
  const allowedExtensions = ['.pdf', '.doc', '.docx'];
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowedExtensions.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error('Please upload PDF, DOC, or DOCX resume only.'));
  }
};

const imageFilter = (req, file, cb) => {
  const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only JPG, PNG, GIF, and WEBP images are allowed.'));
  }
};

const uploadResume = multer({
  storage: resumeStorage,
  fileFilter: resumeFilter,
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
}).single('resume');

const uploadGalleryImage = multer({
  storage: galleryStorage,
  fileFilter: imageFilter,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
}).single('image');

// Multer Error-catching wrappers
const handleResumeUpload = (req, res, next) => {
  uploadResume(req, res, (err) => {
    if (err) {
      console.error('[Multer Resume Upload Error]:', err.message);
      let errMsg = 'Please upload PDF, DOC, or DOCX resume only.';
      if (err.code === 'LIMIT_FILE_SIZE') {
        errMsg = 'File size must be under 5MB.';
      } else if (err.message) {
        errMsg = err.message;
      }
      return res.status(400).json({
        success: false,
        message: errMsg,
        error: errMsg
      });
    }
    next();
  });
};

const handleGalleryUpload = (req, res, next) => {
  uploadGalleryImage(req, res, (err) => {
    if (err) {
      console.error('[Multer Gallery Upload Error]:', err.message);
      return res.status(400).json({
        success: false,
        message: err.message || 'Image upload failed. Max size is 10MB, formats JPG/PNG/WEBP.',
        error: err.message || 'Image upload failed'
      });
    }
    next();
  });
};

// Nodemailer Notification Helper
async function sendMailNotification(to, subject, textContent, htmlContent, attachment = null) {
  const { EMAIL_USER, EMAIL_PASS, SMTP_HOST, SMTP_PORT, SMTP_SECURE } = process.env;
  if (!EMAIL_USER || !EMAIL_PASS) {
    console.log('--- EMAIL FALLBACK LOG ---');
    console.log(`[SMTP Not Configured] Logging email contents:`);
    console.log(`To: ${to}`);
    console.log(`Subject: ${subject}`);
    console.log(`Body:\n${textContent}`);
    if (attachment) {
      console.log(`Attachment: Name=${attachment.filename}, Path=${attachment.path}`);
    }
    console.log('--------------------------');
    return { success: true, pending: true, message: 'SMTP not configured. Email logged to terminal fallback.' };
  }

  try {
    let transporter;
    if (SMTP_HOST) {
      transporter = nodemailer.createTransport({
        host: SMTP_HOST,
        port: parseInt(SMTP_PORT || '587', 10),
        secure: SMTP_SECURE === 'true',
        auth: {
          user: EMAIL_USER,
          pass: EMAIL_PASS
        }
      });
    } else {
      transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          user: EMAIL_USER,
          pass: EMAIL_PASS
        }
      });
    }

    const mailOptions = {
      from: `"Shree Nathji Transport" <${EMAIL_USER}>`,
      to: to,
      subject: subject,
      text: textContent,
      html: htmlContent
    };

    if (attachment) {
      mailOptions.attachments = [
        {
          filename: attachment.filename,
          path: attachment.path
        }
      ];
    }

    const info = await transporter.sendMail(mailOptions);
    console.log('[Nodemailer Email Sent]:', info.messageId);
    return { success: true, pending: false, message: 'Email sent successfully' };
  } catch (error) {
    console.error('[Nodemailer Delivery Failed]:', error.message);
    return { success: false, pending: true, message: `Email delivery failed: ${error.message}` };
  }
}

// Simple Admin Authorization Middleware
function authenticateAdmin(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    console.warn('[Authorization Failed]: Authorization token required');
    return res.status(401).json({
      success: false,
      message: 'Authorization token required',
      error: 'Authorization token required'
    });
  }

  const token = authHeader.split(' ')[1];
  if (token === 'admin-session-token-2026') {
    next();
  } else {
    console.warn('[Authorization Failed]: Invalid token provided');
    res.status(403).json({
      success: false,
      message: 'Invalid authentication token',
      error: 'Invalid authentication token'
    });
  }
}

// API Routes

// 1. Contact Form Inquiry Route
app.post('/api/contact', (req, res, next) => {
  const { name, phone, email, service, message } = req.body;

  if (!name || !phone || !email || !service || !message) {
    return res.status(400).json({
      success: false,
      message: 'All fields (Name, Phone, Email, Service, Message) are required.',
      error: 'All fields are required'
    });
  }

  db.run(
    `INSERT INTO contact_inquiries (name, phone, email, service, message) VALUES (?, ?, ?, ?, ?)`,
    [name, phone, email, service, message],
    async function (err) {
      if (err) {
        console.error('[SQLite Insertion Error - Inquiries]:', err.message);
        return res.status(500).json({
          success: false,
          message: 'Failed to record inquiry in database.',
          error: err.message
        });
      }

      console.log(`[Database Logged]: Saved contact inquiry from ${name} with ID ${this.lastID}`);

      // Send response immediately (non-blocking email)
      res.status(200).json({
        success: true,
        message: 'Inquiry submitted successfully!',
        id: this.lastID
      });

      // Fire-and-forget email notification
      (async () => {
        try {
          const subject = 'New Contact Inquiry - Shree Nathji Transport';
          const textContent = `Name: ${name}\nPhone Number: ${phone}\nEmail Address: ${email}\nService Category: ${service}\nMessage:\n${message}\nSubmission Date & Time: ${new Date().toLocaleString()}`;
          const htmlContent = `<h2>New Contact Inquiry</h2><p><strong>Name:</strong> ${name}</p><p><strong>Phone Number:</strong> ${phone}</p><p><strong>Email Address:</strong> ${email}</p><p><strong>Service Category:</strong> ${service}</p><p><strong>Message:</strong><br/>${message.replace(/\n/g, '<br/>')}</p><p><strong>Submission Date & Time:</strong> ${new Date().toLocaleString()}</p>`;

          await sendMailNotification('nathjitransportkgp@gmail.com', subject, textContent, htmlContent);
        } catch (e) {
          console.error('[Email Error]:', e.message);
        }
      })();
    }
  );
});

// 2. Career Application Route (with file upload)
app.post('/api/careers/apply', handleResumeUpload, (req, res, next) => {
  if (!req.file) {
    return res.status(400).json({
      success: false,
      message: 'Resume file is required (PDF, DOC, DOCX up to 10MB).',
      error: 'Resume file is required'
    });
  }

  const { name, phone, email, location, experience, position, message } = req.body;

  if (!name || !phone || !email || !location || !experience || !position) {
    // Delete file if validations fail
    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    return res.status(400).json({
      success: false,
      message: 'All major fields (Name, Phone, Email, Location, Experience, Position) are required.',
      error: 'All primary fields are required'
    });
  }

  const resumePath = '/uploads/resumes/' + req.file.filename;

  db.run(
    `INSERT INTO career_applications (name, phone, email, location, experience, position, resume_path, resume_name, resume_type, message, status) 
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    [name, phone, email, location, experience, position, resumePath, req.file.originalname, req.file.mimetype, message || ''],
    async function (err) {
      if (err) {
        console.error('[SQLite Insertion Error - Careers]:', err.message);
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        return res.status(500).json({
          success: false,
          message: 'Failed to save application in database.',
          error: err.message
        });
      }

      console.log(`[Database Logged]: Saved career application from ${name} with ID ${this.lastID}`);

      // Send response immediately (non-blocking emails)
      res.status(200).json({
        success: true,
        message: 'Application submitted successfully!',
        id: this.lastID
      });

      // Fire-and-forget email notifications
      (async () => {
        try {
          const subject = 'New Career Application Received';
          const textContent = `Applicant Name: ${name}\nEmail: ${email}\nPhone Number: ${phone}\nApplied Position: ${position}\nExperience: ${experience}\nSubmission Date & Time: ${new Date().toLocaleString()}`;
          const htmlContent = `<h2>New Career Application Received</h2><p><strong>Applicant Name:</strong> ${name}</p><p><strong>Email:</strong> ${email}</p><p><strong>Phone Number:</strong> ${phone}</p><p><strong>Applied Position:</strong> ${position}</p><p><strong>Experience:</strong> ${experience}</p><p><strong>Submission Date & Time:</strong> ${new Date().toLocaleString()}</p>`;

          const attachment = {
            filename: req.file.originalname,
            path: req.file.path
          };

          // Admin internal notification
          await sendMailNotification('nathjitransportkgp@gmail.com', subject, textContent, htmlContent, attachment);

          // Auto-reply to applicant
          const replySubject = 'Application Received - Shree Nathji Transport';
          const replyText = `Thank you for applying to Shree Nathji Transport.\n\nWe have successfully received your application and our recruitment team will review it shortly.\n\nIf your profile matches our requirements, we will contact you for the next stage of the process.\n\nRegards,\nShree Nathji Transport`;
          const replyHtml = `<p>Thank you for applying to Shree Nathji Transport.</p><p>We have successfully received your application and our recruitment team will review it shortly.</p><p>If your profile matches our requirements, we will contact you for the next stage of the process.</p><p>Regards,<br/>Shree Nathji Transport</p>`;

          await sendMailNotification(email, replySubject, replyText, replyHtml);
        } catch (e) {
          console.error('[Email Error]:', e.message);
        }
      })();
    }
  );
});

// 3. Get Gallery Images Route
app.get('/api/gallery', (req, res, next) => {
  db.all('SELECT * FROM gallery ORDER BY id DESC', (err, rows) => {
    if (err) {
      console.error('[SQLite Query Error - Gallery]:', err.message);
      return res.status(500).json([]);
    }
    
    // Map database columns to support both backward compatible url and new standardized imageUrl
    const formattedRows = (rows || []).map(row => ({
      id: row.id,
      title: row.title,
      category: row.category,
      url: row.url,
      imageUrl: row.url,
      createdAt: row.created_at
    }));

    res.status(200).json(formattedRows);
  });
});

// 4. Admin Login Route
app.post('/api/admin/login', (req, res, next) => {
  const { username, password } = req.body;
  
  const expectedUser = process.env.ADMIN_USER || 'admin';
  const expectedPass = process.env.ADMIN_PASS || 'nathji2026';

  if (username === expectedUser && password === expectedPass) {
    console.log(`[Admin Login]: Admin logged in successfully.`);
    res.status(200).json({ 
      success: true, 
      message: 'Login successful',
      token: 'admin-session-token-2026', 
      user: { username } 
    });
  } else {
    console.warn(`[Admin Login Failed]: Invalid credentials entered.`);
    res.status(401).json({ 
      success: false,
      message: 'Invalid username or password.',
      error: 'Invalid username or password' 
    });
  }
});

// 5. Upload Gallery Image Route (Admin protected)
app.post('/api/gallery/upload', authenticateAdmin, handleGalleryUpload, (req, res, next) => {
  if (!req.file) {
    return res.status(400).json({
      success: false,
      message: 'Image file is required.',
      error: 'Image file is required'
    });
  }

  const { category, title } = req.body;

  if (!category || !title) {
    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    return res.status(400).json({
      success: false,
      message: 'Category and title are required fields.',
      error: 'Category and title are required'
    });
  }

  const url = '/uploads/gallery/' + req.file.filename;

  db.run(
    `INSERT INTO gallery (url, category, title) VALUES (?, ?, ?)`,
    [url, category, title],
    function (err) {
      if (err) {
        console.error('[SQLite Insertion Error - Gallery Upload]:', err.message);
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        return res.status(500).json({
          success: false,
          message: 'Failed to record image in database.',
          error: err.message
        });
      }

      console.log(`[Gallery Uploaded]: Saved new picture "${title}" under ${category} with ID ${this.lastID}`);

      res.status(200).json({ 
        success: true, 
        message: 'Photo published successfully!',
        id: this.lastID, 
        title,
        category,
        imageUrl: url,
        url,
        createdAt: new Date().toISOString()
      });
    }
  );
});

// 5.1 General Media Upload Route (Admin protected)
app.post('/api/admin/upload-media', authenticateAdmin, handleGalleryUpload, (req, res, next) => {
  if (!req.file) {
    return res.status(400).json({
      success: false,
      message: 'Image file is required.',
      error: 'Image file is required'
    });
  }
  const url = '/uploads/gallery/' + req.file.filename;
  console.log(`[Media Uploaded]: Saved dynamic file at path: ${url}`);
  res.status(200).json({
    success: true,
    message: 'Image uploaded successfully!',
    url
  });
});

// 6. Delete Gallery Image Route (Admin protected)
app.delete('/api/gallery/:id', authenticateAdmin, (req, res, next) => {
  const { id } = req.params;

  db.get('SELECT url FROM gallery WHERE id = ?', [id], (err, row) => {
    if (err) {
      console.error('[SQLite Error - Find Image for Delete]:', err.message);
      return res.status(500).json({
        success: false,
        message: 'Failed to query database for image.',
        error: err.message
      });
    }

    if (!row) {
      return res.status(404).json({
        success: false,
        message: 'Image not found in gallery database.',
        error: 'Image not found'
      });
    }

    db.run('DELETE FROM gallery WHERE id = ?', [id], function (err) {
      if (err) {
        console.error('[SQLite Error - Delete Gallery]:', err.message);
        return res.status(500).json({
          success: false,
          message: 'Failed to delete photo from database.',
          error: err.message
        });
      }

      if (row.url.startsWith('/uploads/')) {
        const filePath = path.join(__dirname, row.url);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          console.log(`[File Deleted]: Removed file on disk at: ${filePath}`);
        }
      }

      console.log(`[Gallery Deleted]: Deleted image ID ${id} from database.`);
      res.status(200).json({
        success: true,
        message: 'Photo deleted successfully!'
      });
    });
  });
});

// 7. Get Job Applications Route (Admin protected)
app.get('/api/admin/applications', authenticateAdmin, (req, res, next) => {
  db.all('SELECT * FROM career_applications ORDER BY id DESC', (err, rows) => {
    if (err) {
      console.error('[SQLite Error - Admin Fetch Applications]:', err.message);
      return res.status(500).json({
        success: false,
        message: 'Failed to query applications from database.',
        error: err.message,
        applications: []
      });
    }
    res.status(200).json({
      success: true,
      applications: rows || []
    });
  });
});

// GET /api/careers (Returns a direct array of job applications with standardized attributes)
app.get('/api/careers', (req, res, next) => {
  db.all('SELECT * FROM career_applications ORDER BY id DESC', (err, rows) => {
    if (err) {
      console.error('[SQLite Error - Fetch Careers]:', err.message);
      return res.status(500).json([]);
    }

    const formatted = (rows || []).map(row => ({
      id: row.id,
      name: row.name,
      email: row.email,
      phone: row.phone,
      position: row.position,
      experience: row.experience,
      coverLetter: row.message || '',
      resumeUrl: row.resume_path,
      resumeName: row.resume_name || 'Resume.pdf',
      resumeType: row.resume_type || 'application/pdf',
      status: row.status || 'pending',
      createdAt: row.created_at
    }));

    res.status(200).json(formatted);
  });
});

// PUT /api/careers/:id/status (Admin protected - updates status of career applications)
app.put('/api/careers/:id/status', authenticateAdmin, (req, res, next) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!status) {
    return res.status(400).json({ success: false, message: 'Status is required' });
  }

  db.run('UPDATE career_applications SET status = ? WHERE id = ?', [status, id], function (err) {
    if (err) {
      console.error('[SQLite Error - Update Career Status]:', err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
    
    console.log(`[Database Logged]: Updated status of career application ID ${id} to ${status}`);
    res.status(200).json({ success: true, message: 'Status updated successfully!' });
  });
});

// DELETE /api/careers/:id (Admin protected - deletes application and resume file)
app.delete('/api/careers/:id', authenticateAdmin, (req, res, next) => {
  const { id } = req.params;

  db.get('SELECT resume_path FROM career_applications WHERE id = ?', [id], (err, row) => {
    if (err) {
      console.error('[SQLite Error - Find Application for Delete]:', err.message);
      return res.status(500).json({ success: false, error: err.message });
    }

    db.run('DELETE FROM career_applications WHERE id = ?', [id], function (err) {
      if (err) {
        console.error('[SQLite Error - Delete Application]:', err.message);
        return res.status(500).json({ success: false, error: err.message });
      }

      if (row && row.resume_path) {
        const filePath = path.join(__dirname, row.resume_path);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          console.log(`[File Deleted]: Removed resume file on disk at: ${filePath}`);
        }
      }

      console.log(`[Career Deleted]: Deleted application ID ${id} from database.`);
      res.status(200).json({ success: true, message: 'Application deleted successfully!' });
    });
  });
});

// 8. Get Contact Inquiries Route (Admin protected)
app.get('/api/admin/inquiries', authenticateAdmin, (req, res, next) => {
  db.all('SELECT * FROM contact_inquiries ORDER BY id DESC', (err, rows) => {
    if (err) {
      console.error('[SQLite Error - Admin Fetch Inquiries]:', err.message);
      return res.status(500).json({
        success: false,
        message: 'Failed to query inquiries from database.',
        error: err.message,
        inquiries: []
      });
    }
    res.status(200).json({
      success: true,
      inquiries: rows || []
    });
  });
});

// GET /api/contact (Returns a direct array of contact submissions with standardized attributes)
app.get('/api/contact', (req, res, next) => {
  db.all('SELECT * FROM contact_inquiries ORDER BY id DESC', (err, rows) => {
    if (err) {
      console.error('[SQLite Error - Fetch Contacts]:', err.message);
      return res.status(500).json([]);
    }

    const formatted = (rows || []).map(row => ({
      id: row.id,
      name: row.name,
      email: row.email,
      phone: row.phone,
      service: row.service,
      message: row.message,
      status: row.status || 'unread',
      createdAt: row.created_at
    }));

    res.status(200).json(formatted);
  });
});

// PUT /api/contact/:id/status (Admin protected - updates status of contact submission)
app.put('/api/contact/:id/status', authenticateAdmin, (req, res, next) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!status) {
    return res.status(400).json({ success: false, message: 'Status is required' });
  }

  db.run('UPDATE contact_inquiries SET status = ? WHERE id = ?', [status, id], function (err) {
    if (err) {
      console.error('[SQLite Error - Update Contact Status]:', err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
    
    console.log(`[Database Logged]: Updated status of contact inquiry ID ${id} to ${status}`);
    res.status(200).json({ success: true, message: 'Status updated successfully!' });
  });
});

// DELETE /api/contact/:id (Admin protected - deletes contact submission)
app.delete('/api/contact/:id', authenticateAdmin, (req, res, next) => {
  const { id } = req.params;

  db.run('DELETE FROM contact_inquiries WHERE id = ?', [id], function (err) {
    if (err) {
      console.error('[SQLite Error - Delete Contact]:', err.message);
      return res.status(500).json({ success: false, error: err.message });
    }

    console.log(`[Contact Deleted]: Deleted contact inquiry ID ${id} from database.`);
    res.status(200).json({ success: true, message: 'Contact inquiry deleted successfully!' });
  });
});

// Serve frontend dist statically in production
app.use(express.static(path.join(__dirname, '../dist')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../dist/index.html'));
});

// Centralized Backend JSON Error Handler
app.use((err, req, res, next) => {
  console.error('[Express Uncaught Exception Error]:', err);
  res.status(res.headersSent ? 500 : (err.status || 500)).json({
    success: false,
    message: err.message || 'Internal server error occurred.',
    error: err.message || 'Internal server error occurred.'
  });
});

// Start Server
app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
});
