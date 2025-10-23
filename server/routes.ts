import type { Express } from "express";
import { createServer, type Server } from "http";
import multer from "multer";
import path from "path";
import { storage } from "./storage";
import { sendMessage } from "./ai";
import { insertChatSessionSchema, insertMessageSchema } from "@shared/schema";


const upload = multer({ 
  dest: 'uploads/',
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

declare module "express-session" {
  interface SessionData {
    sessionId: string; 
  }
}

export async function registerRoutes(app: Express): Promise<Server> {
  
  // ============ Sessions API ============
  
  // Get all sessions
  app.get("/api/sessions", async (req, res) => {
    try {
      if (req.session.sessionId) {
        const session = await storage.getSession(req.session.sessionId);
        if (session) {
          return res.json([session]);
        }
      }
      res.json([]);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Get single session
  app.get("/api/sessions/:id", async (req, res) => {
    try {
      const session = await storage.getSession(req.params.id);
      if (!session) {
        return res.status(404).json({ error: "Session not found" });
      }
      res.json(session);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Create new session
  app.post("/api/sessions", async (req, res) => {
    try {
      let currentSessionId = req.session.sessionId;
      let session;

      if (currentSessionId) {
        session = await storage.getSession(currentSessionId);
        if (session) {
          return res.status(200).json(session); // Session already exists
        }
      }

      // If no session or session not found, create a new one
      const validated = insertChatSessionSchema.parse(req.body);
      session = await storage.createSession(validated);
      req.session.sessionId = session.id; // Store new session ID
      res.status(201).json(session);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  // Update session
  app.patch("/api/sessions/:id", async (req, res) => {
    try {
      const session = await storage.updateSession(req.params.id, req.body);
      if (!session) {
        return res.status(404).json({ error: "Session not found" });
      }
      res.json(session);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  // Delete session
  app.delete("/api/sessions/:id", async (req, res) => {
    try {
      const deleted = await storage.deleteSession(req.params.id);
      if (!deleted) {
        return res.status(404).json({ error: "Session not found" });
      }
      res.status(204).send();
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ============ Messages API ============

  // Get messages for a session
  app.get("/api/sessions/:sessionId/messages", async (req, res) => {
    try {
      const messages = await storage.getMessages(req.params.sessionId);
      res.json(messages);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Send message and get AI response
  app.post("/api/sessions/:sessionId/messages", async (req, res) => {
    try {
      const { content, model = 'gpt-5', attachmentIds = [] } = req.body;

      if (!content || typeof content !== 'string') {
        return res.status(400).json({ error: "Content is required" });
      }

      // Get session to verify it exists
      const session = await storage.getSession(req.params.sessionId);
      if (!session) {
        return res.status(404).json({ error: "Session not found" });
      }

      // Get attachments if any
      let attachmentsData = null;
      if (attachmentIds.length > 0) {
        const attachments = await Promise.all(
          attachmentIds.map((id: string) => storage.getAttachment(id))
        );
        attachmentsData = attachments.filter(Boolean);
      }

      // Save user message
      const userMessage = await storage.createMessage({
        sessionId: req.params.sessionId,
        role: 'user',
        content,
        attachments: attachmentsData,
        metadata: null,
      });

      // Get conversation history
      const history = await storage.getMessages(req.params.sessionId);
      const chatMessages = history.map(msg => ({
        role: msg.role as 'system' | 'user' | 'assistant',
        content: msg.content,
      }));

      // Get AI response
      const aiResponse = await sendMessage(chatMessages, model);

      // Save AI message
      const aiMessage = await storage.createMessage({
        sessionId: req.params.sessionId,
        role: 'assistant',
        content: aiResponse.content,
        attachments: null,
        metadata: { 
          model: aiResponse.model, 
          usage: aiResponse.usage 
        },
      });

      res.json({
        userMessage,
        aiMessage,
      });
    } catch (error: any) {
      console.error('Message send error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Delete message
  app.delete("/api/messages/:id", async (req, res) => {
    try {
      const deleted = await storage.deleteMessage(req.params.id);
      if (!deleted) {
        return res.status(404).json({ error: "Message not found" });
      }
      res.status(204).send();
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ============ File Upload API ============

  app.post("/api/upload", upload.array('files', 5), async (req, res) => {
    try {
      if (!req.files || !Array.isArray(req.files)) {
        return res.status(400).json({ error: "No files uploaded" });
      }

      const attachments = await Promise.all(
        req.files.map(file => 
          storage.createAttachment({
            filename: file.originalname,
            mimetype: file.mimetype,
            size: file.size.toString(),
            path: file.path,
          })
        )
      );

      res.json(attachments);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}
