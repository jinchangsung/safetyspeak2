import { GoogleGenAI, Modality } from "@google/genai";
import { TargetLanguage } from "../types";
import { decodeBase64, decodeAudioData } from "./audioUtils";
import { fileToBase64, fileToArrayBuffer, fileToText } from "./fileUtils";
// @ts-ignore
import mammoth from "mammoth";
// @ts-ignore
import readXlsxFile from "read-excel-file";

// Check for API Key availability
const API_KEY = process.env.API_KEY;

// Initialize Gemini client only if key is valid-ish, otherwise calls will fail gracefully
const ai = new GoogleGenAI({ apiKey: API_KEY || "dummy_key_to_prevent_init_crash" });

// Helper to validate API key before making requests
const validateApiKey = () => {
  if (!API_KEY || API_KEY.startsWith("YOUR_GEMINI") || API_KEY === "undefined") {
    throw new Error(
      "API 키가 설정되지 않았습니다. .env 파일에 키를 넣거나, GitHub Settings > Secrets에 'API_KEY'를 추가해주세요."
    );
  }
};

/**
 * Extracts text from a given file.
 * Tries client-side parsing first for known formats (DOCX, XLSX, TXT) to save tokens and ensure compatibility.
 * Falls back to Gemini multimodal extraction for PDF and images.
 */
export const extractTextFromFile = async (file: File): Promise<string> => {
  const lowerName = file.name.toLowerCase();

  try {
    // 1. Handle DOCX
    if (lowerName.endsWith('.docx')) {
      const arrayBuffer = await fileToArrayBuffer(file);
      const result = await mammoth.extractRawText({ arrayBuffer });
      return result.value.trim();
    }

    // 2. Handle XLSX
    if (lowerName.endsWith('.xlsx')) {
      const rows = await readXlsxFile(file);
      // Convert rows to CSV-like string
      return rows.map((row: any[]) => row.join(' ')).join('\n').trim();
    }

    // 3. Handle TXT
    if (lowerName.endsWith('.txt')) {
      return await fileToText(file);
    }

    // 4. Handle PDF (Send to Gemini)
    if (lowerName.endsWith('.pdf')) {
        validateApiKey(); // Ensure key exists before calling API
        const base64Data = await fileToBase64(file);
        const prompt = `
          Extract all readable text from this PDF document. 
          Ignore layout and styling. Return only the text content suitable for safety education translation.
        `;
        
        const response = await ai.models.generateContent({
            model: 'gemini-3-flash-preview', // Gemini Flash handles PDFs efficiently
            contents: {
                parts: [
                    { inlineData: { mimeType: 'application/pdf', data: base64Data } },
                    { text: prompt }
                ]
            }
        });
        return response.text?.trim() || "";
    }

    // 5. Handle HWP / PPTX (Attempt via Gemini or Fail gracefully)
    // Gemini InlineData DOES NOT officially support HWP/PPTX.
    if (lowerName.endsWith('.hwp') || lowerName.endsWith('.pptx')) {
         throw new Error("HWP 및 PPTX 파일은 현재 직접 처리가 어렵습니다. 내용을 복사하여 붙여넣거나 PDF로 변환하여 업로드해주세요.");
    }

    throw new Error("지원되지 않는 파일 형식입니다.");

  } catch (error: any) {
    console.error("File Extraction Error:", error);
    if (error.message.includes("API 키")) throw error;
    if (error.message.includes("HWP") || error.message.includes("PPTX")) throw error;
    if (error.message?.includes('400')) {
       throw new Error("파일 형식이 올바르지 않거나 AI가 처리할 수 없습니다. PDF로 변환 후 시도해주세요.");
    }
    throw new Error("파일 내용을 읽는 중 오류가 발생했습니다: " + (error.message || "Unknown error"));
  }
};

/**
 * Step 1: Translate the Korean text to the target language.
 * Uses a standard Flash model for speed and accuracy.
 */
export const translateSafetyText = async (
  text: string,
  targetLang: TargetLanguage
): Promise<string> => {
  validateApiKey(); // Validate key

  const prompt = `
    You are a professional construction safety interpreter. 
    Translate the following safety education material from Korean to ${targetLang}.
    
    Guidelines:
    1. Maintain a serious, authoritative, and instructional tone suitable for construction workers.
    2. Ensure safety terminology is accurate in the target language.
    3. Do not add any conversational filler. Output ONLY the translated text.
    
    Original Text:
    ${text}
  `;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: prompt,
    });

    const translatedText = response.text;
    if (!translatedText) throw new Error("Translation failed: Empty response");
    
    return translatedText.trim();
  } catch (error: any) {
    console.error("Translation Error:", error);
    throw new Error(`번역 실패: ${error.message || "알 수 없는 오류"}`);
  }
};

/**
 * Step 2: Convert the translated text to speech using Gemini TTS.
 * Returns an AudioBuffer ready to play.
 */
export const generateSpeech = async (
  text: string,
  audioContext: AudioContext
): Promise<AudioBuffer> => {
  validateApiKey(); // Validate key

  // TTS has limitations on length. 4000 characters is a safe upper bound for a single request.
  if (text.length > 4000) {
      throw new Error("번역된 텍스트가 너무 길어(4000자 초과) 음성으로 변환할 수 없습니다. 내용을 나누어 입력해주세요.");
  }

  try {
    // We strictly use the TTS-capable model
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-preview-tts",
      contents: [{ parts: [{ text: text }] }],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: 'Kore' },
          },
        },
      },
    });

    const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    
    if (!base64Audio) {
      throw new Error("모델이 오디오 데이터를 반환하지 않았습니다.");
    }

    // Decode the raw PCM data
    const audioBytes = decodeBase64(base64Audio);
    // decodeAudioData can fail if data is corrupt
    try {
        const audioBuffer = await decodeAudioData(audioBytes, audioContext, 24000, 1);
        return audioBuffer;
    } catch (decodeErr) {
        console.error("Decode Error:", decodeErr);
        throw new Error("오디오 데이터 디코딩에 실패했습니다.");
    }
    
  } catch (error: any) {
    console.error("TTS Error:", error);
    let errorMessage = "음성 생성에 실패했습니다.";
    if (error.message) {
        // Translate common errors to Korean if possible, or just append
        if (error.message.includes('400')) errorMessage += " (요청 형식이 잘못되었습니다)";
        else if (error.message.includes('429')) errorMessage += " (요청이 너무 많습니다)";
        else errorMessage += ` (${error.message})`;
    }
    throw new Error(errorMessage);
  }
};