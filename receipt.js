/* ═══════════════════════════════════════════════════════════════
   receipt.js — BlueLedger Intelligent Receipt & Invoice Parser
   Handles: File uploads, OCR pipeline, and automated form entry.
   ═══════════════════════════════════════════════════════════════ */

"use strict";

/**
 * Triggers the file selection dialog for receipt images
 * @param {string} inputId - ID of the hidden file input element
 */
function triggerReceiptScan(inputId) {
  const fileInput = document.getElementById(inputId);
  if (fileInput) {
    fileInput.click();
  }
}

/**
 * Main execution method handler for chosen receipt files
 * @param {Event} event - File input change event
 */
async function processReceiptUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  console.log(`[ReceiptAI] Scanning image file: ${file.name}`);

  // Show a visual loader to the user if a global loader function exists
  if (typeof showGlobalLoader === "function") {
    showGlobalLoader("Analyzing receipt with AI...");
  }

  try {
    /*  PRODUCTION IMPLMENTATION NOTE:
      Pass the file payload to your backend or serverless functions like so:
      
      const formData = new FormData();
      formData.append("receipt", file);
      const res = await fetch("/api/parse-receipt", { method: "POST", body: formData });
      const data = await res.json();
    */

    // Simulated parsing engine latency (1.5 seconds)
    const extractedData = await simulateReceiptOcr(file.name);

    console.log("[ReceiptAI] Extracted payload successfully:", extractedData);

    // Auto-fill BlueLedger form arrays or trigger the built-in modal
    populateDraftForm(extractedData);
  } catch (error) {
    console.error("[ReceiptAI] Critical failure scanning receipt:", error);
    alert(
      "Could not process receipt. Please ensure text is legible and try again.",
    );
  } finally {
    if (typeof hideGlobalLoader === "function") {
      hideGlobalLoader();
    }
  }
}

/**
 * Simulated Smart-OCR Parser for testing dashboard layouts
 * Generates structured context based on sample patterns
 */
function simulateReceiptOcr(fileName) {
  return new Promise((resolve) => {
    setTimeout(() => {
      // Return contextual mock data based on names or standard defaults
      if (
        fileName.toLowerCase().includes("uber") ||
        fileName.toLowerCase().includes("cab")
      ) {
        resolve({
          description: "Uber Trip",
          amount: 850.0,
          category: "Travel",
          date: new Date().toISOString().split("T")[0],
        });
      } else {
        // Fallback default matching your dashboard's sample transaction
        resolve({
          description: "L'Atelier Resto",
          amount: 420.0,
          category: "Dining",
          date: new Date().toISOString().split("T")[0],
        });
      }
    }, 1500);
  });
}

/**
 * Pre-fills the draft context fields inside your application
 */
function populateDraftForm(data) {
  // 1. Try mapping directly to your DOM inputs if standard layout inputs exist
  const descInput =
    document.getElementById("blTxnDesc") ||
    document.getElementById("transactionDescription");
  const amtInput =
    document.getElementById("blTxnAmt") ||
    document.getElementById("transactionAmount");
  const catInput =
    document.getElementById("blTxnCat") ||
    document.getElementById("transactionCategory");

  if (descInput) descInput.value = data.description;
  if (amtInput) amtInput.value = data.amount;
  if (catInput) catInput.value = data.category;

  // 2. Fallback execution: Check if your script(19).js uses an entry point modal handler
  if (typeof openAddTransactionModal === "function") {
    openAddTransactionModal({
      type: "expense",
      ...data,
    });
  } else {
    // Alert feedback detailing successful parsing if modals are closed
    alert(
      ` AI Receipt Found!\n\nMerchant: ${data.description}\nAmount: ₹${data.amount}\nCategory: ${data.category}`,
    );
  }
}
