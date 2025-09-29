const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { google } = require("googleapis");

admin.initializeApp();
const db = admin.firestore();

const OAUTH_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const OAUTH_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

exports.fetchEmails = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "The function must be called while authenticated.");
  }

  const uid = request.auth.uid;
  const serverAuthCode = request.data.code;

  // --- Token Authentication (No changes needed here) ---
  const userDoc = await db.collection("users").doc(uid).get();
  const savedRefreshToken = userDoc.data()?.gmailRefreshToken;
  const oauth2Client = new google.auth.OAuth2(OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, "http://localhost");
  let tokens;

  if (savedRefreshToken) {
    oauth2Client.setCredentials({ refresh_token: savedRefreshToken });
    try {
      const newTokens = await oauth2Client.refreshAccessToken();
      tokens = newTokens.credentials;
    } catch (error) {
      console.error("Error refreshing access token:", error);
      throw new HttpsError("internal", "Failed to refresh access token.");
    }
  } else {
    if (!serverAuthCode) {
      throw new HttpsError("invalid-argument", "Server auth code is required.");
    }
    try {
      const { tokens: newTokens } = await oauth2Client.getToken(serverAuthCode);
      tokens = newTokens;
      if (tokens.refresh_token) {
        await db.collection("users").doc(uid).set({ gmailRefreshToken: tokens.refresh_token }, { merge: true });
      }
    } catch (error) {
      console.error("Error exchanging server auth code:", error);
      throw new HttpsError("internal", "Token exchange failed.");
    }
  }
  
  oauth2Client.setCredentials(tokens);
  const gmail = google.gmail({ version: "v1", auth: oauth2Client });

  // --- Email Fetching and Processing ---
  try {
    const listResponse = await gmail.users.messages.list({
      userId: "me",
      maxResults: 100, // Fetch up to 100 message IDs
      q: "is:inbox",
    });

    const messages = listResponse.data.messages || [];
    if (messages.length === 0) {
      return { status: "success", message: "No new emails found." };
    }

    // ✅ IMPROVEMENT #1: Create an array of promises for all API calls
    const emailDetailPromises = messages.map(message => 
      gmail.users.messages.get({
        userId: "me",
        id: message.id,
        format: "metadata",
        metadataHeaders: ["Subject", "From"],
      })
    );

    // ✅ Execute all API calls in parallel for a massive speed boost
    const emailDetailsResponses = await Promise.all(emailDetailPromises);

    // ✅ IMPROVEMENT #2: Use a Firestore Write Batch for efficient writes
    const batch = db.batch();

    emailDetailsResponses.forEach(msgResponse => {
      const headers = msgResponse.data.payload.headers;
      const subject = headers.find((h) => h.name === "Subject")?.value || "";
      const from = headers.find((h) => h.name === "From")?.value || "";
      const body = msgResponse.data.snippet;

      // Get a reference to the new document in the subcollection
      const docRef = db.collection("users").doc(uid).collection("emails").doc(msgResponse.data.id);
      
      // Add the 'set' operation to the batch
      batch.set(docRef, {
        subject,
        from,
        bodySnippet: body,
        receivedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    // Commit all the writes to the database in a single operation
    await batch.commit();

    // ✅ IMPROVEMENT #3: Return a simple, efficient success message
    return { status: "success", message: `${messages.length} emails are being synced.` };

  } catch (error) {
    console.error("Error fetching or processing emails:", error);
    throw new HttpsError("internal", "Failed to process emails.");
  }
});