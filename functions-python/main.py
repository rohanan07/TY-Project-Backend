# main.py
# Triggering a new deployment
import firebase_admin
from firebase_functions import firestore_fn, options
from firebase_admin import firestore
import joblib
import tensorflow as tf
from transformers import DistilBertTokenizer, TFDistilBertForSequenceClassification

# This requests more memory and a longer timeout for the deployed function.
options.set_global_options(max_instances=10, memory=options.MemoryOption.GB_1, timeout_sec=300)

# Initialize Firebase
firebase_admin.initialize_app()

# Define the path to your assets
MODEL_DIR = "./model_assets"

# --- Load all assets into memory on startup for efficiency ---
try:
    print("Loading tokenizer, model, and label encoder...")
    tokenizer = DistilBertTokenizer.from_pretrained(MODEL_DIR)
    model = TFDistilBertForSequenceClassification.from_pretrained(MODEL_DIR)
    label_encoder = joblib.load(f"{MODEL_DIR}/label_encoder.pkl")
    print("All assets loaded successfully!")
except Exception as e:
    print(f"CRITICAL: Error loading model assets: {e}")
    tokenizer = model = label_encoder = None

# ✅ This is a Firestore Trigger.
# It automatically runs whenever a NEW document is created in users/{userId}/emails/{emailId}
@firestore_fn.on_document_created("users/{userId}/emails/{emailId}")
def classifyEmail(event: firestore_fn.Event[firestore_fn.Change]) -> None:
    """Triggers when a new email is saved, classifies it, and updates the document."""
    if model is None:
        print("Model is not loaded. Aborting classification.")
        return

    try:
        # Get the UID and Email ID from the path of the document that was created
        user_id = event.params["userId"]
        email_id = event.params["emailId"]
        
        # Get the data from the newly created email document
        email_data = event.data.to_dict()
        subject = email_data.get("subject", "")
        snippet = email_data.get("bodySnippet", "")
        
        # Combine subject and snippet for better classification
        text_to_classify = f"{subject} {snippet}"

        # --- Run Prediction ---
        inputs = tokenizer(text_to_classify, return_tensors="tf", padding=True, truncation=True)
        logits = model(inputs).logits
        predicted_class_idx = tf.argmax(logits, axis=1).numpy()[0]
        predicted_label = label_encoder.inverse_transform([predicted_class_idx])[0]
        
        print(f"Classified email {email_id} for user {user_id} as: {predicted_label}")
        
        # --- Update the Original Document ---
        # Get a reference to the document that triggered this function
        email_ref = firestore.client().collection("users").document(user_id).collection("emails").document(email_id)
        
        # Update the document by adding the 'category' field
        email_ref.update({"category": predicted_label})

    except Exception as e:
        print(f"An error occurred during classification: {e}")