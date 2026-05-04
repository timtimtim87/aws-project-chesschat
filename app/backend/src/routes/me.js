import { CognitoIdentityProviderClient, AdminDeleteUserCommand } from "@aws-sdk/client-cognito-identity-provider";
import { Router } from "express";
import { config } from "../config.js";
import { deleteUser, ensureUser, getUser, looksLikeOpaqueUsername, setUsername } from "../services/dynamodb.js";
import { sendHttpError } from "../utils/errors.js";
import { log } from "../utils/logger.js";

const cognito = new CognitoIdentityProviderClient({ region: config.cognito.region });

const router = Router();

router.get("/me", async (req, res) => {
  try {
    const userId = req.auth.sub;
    const email = req.auth.email || "";
    const cognitoUsername = req.auth["cognito:username"] || "";

    await ensureUser({
      userId,
      username: undefined,
      email,
      displayName: undefined
    });

    let user = await getUser(userId);

    // For email/password signups, Cognito sets preferred_username from the signup form.
    // Auto-claim it on first login so the user doesn't have to pick again.
    const preferredUsername = req.auth["preferred_username"];
    if (!user?.username && preferredUsername) {
      try {
        await setUsername(userId, preferredUsername, null);
        user = await getUser(userId);
      } catch {
        // conflict or validation error — user will be prompted to pick manually
      }
    }

    const effectiveUser = user || {
      user_id: userId,
      username: null,
      display_name: null,
      email,
      wins: 0,
      losses: 0,
      draws: 0
    };
    const needsUsername =
      !effectiveUser.username || looksLikeOpaqueUsername(effectiveUser.username) || effectiveUser.username === cognitoUsername;
    res.json({ user: effectiveUser, needs_username: needsUsername });
  } catch {
    sendHttpError(res, 500, "INTERNAL_ERROR");
  }
});

router.post("/profile", async (req, res) => {
  try {
    const userId = req.auth.sub;
    const requestedUsername = req.body?.username;
    const user = await getUser(userId);
    if (!user) {
      sendHttpError(res, 404, "INVALID_PAYLOAD", { message: "User profile not found." });
      return;
    }

    const currentUsername = looksLikeOpaqueUsername(user.username) ? user.username : null;
    const username = await setUsername(userId, requestedUsername, currentUsername);
    const updated = await getUser(userId);
    res.json({
      user: updated,
      username,
      needs_username: false
    });
  } catch (error) {
    if (error.code === "INVALID_USERNAME") {
      sendHttpError(res, 400, "INVALID_PAYLOAD", { message: error.message });
      return;
    }
    if (error.code === "USERNAME_TAKEN") {
      sendHttpError(res, 409, "INVALID_PAYLOAD", { message: error.message });
      return;
    }
    sendHttpError(res, 500, "INTERNAL_ERROR");
  }
});

router.delete("/me", async (req, res) => {
  try {
    const userId = req.auth.sub;
    const cognitoUsername = req.auth.username || req.auth["cognito:username"] || userId;

    await deleteUser(userId);

    try {
      await cognito.send(
        new AdminDeleteUserCommand({
          UserPoolId: config.cognito.userPoolId,
          Username: cognitoUsername
        })
      );
    } catch (cognitoErr) {
      // DynamoDB records are gone so the username is freed and re-registration works.
      // A Cognito ghost account without DynamoDB backing cannot log in and is harmless
      // until a manual cleanup resolves it.
      log("warn", "cognito_delete_user_failed", { cognitoUsername, error: cognitoErr.message });
    }

    res.status(204).end();
  } catch {
    sendHttpError(res, 500, "INTERNAL_ERROR");
  }
});

export default router;
