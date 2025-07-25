import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";

// Load environment variables from .env file
dotenv.config();

const { ELEVENLABS_AGENT_ID, ELEVENLABS_API_KEY } = process.env;

if (!ELEVENLABS_AGENT_ID || !ELEVENLABS_API_KEY) {
  console.error("Missing ELEVENLABS_AGENT_ID or ELEVENLABS_API_KEY in environment variables");
  process.exit(1);
}

const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const PORT = process.env.PORT || 8000;

fastify.get("/", async (_, reply) => {
  reply.send({ message: "Server is running" });
});

fastify.all("/twilio/inbound_call", async (request, reply) => {
  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Connect>
        <Stream url="wss://${request.headers.host}/media-stream" />
      </Connect>
    </Response>`;
  reply.type("text/xml").send(twimlResponse);
});

async function getSignedUrl() {
  try {
    const response = await fetch(`https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${ELEVENLABS_AGENT_ID}`, {
      method: "GET",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to get signed URL: ${response.statusText}`);
    }

    const data = await response.json();
    return data.signed_url;
  } catch (error) {
    console.error("Error getting signed URL:", error);
    throw error;
  }
}

fastify.register(async fastifyInstance => {
  fastifyInstance.get("/media-stream", { websocket: true }, (ws, req) => {
    console.info("[Server] Twilio connected to media stream");

    let streamSid = null;
    let callSid = null;
    let elevenLabsWs = null;

    // Extract query params immediately
    const url = new URL(req.url, `http://${req.headers.host}`);
    const phone = url.searchParams.get("phone");
    const clientId = url.searchParams.get("client_id");

    console.log(`[DEBUG] Extracted query from req.url – phone=${phone}, clientId=${clientId}`);

    const setupElevenLabs = async () => {
      try {
        const signedUrl = await getSignedUrl();
        elevenLabsWs = new WebSocket(signedUrl);

        elevenLabsWs.on("open", () => {
          console.log("[ElevenLabs] Connected to Conversational AI");
          console.log(`[DEBUG] Injecting custom_parameters: phone=${phone}, client_id=${clientId}`);

          const initialConfig = {
            type: "conversation_initiation_client_data",
            custom_parameters: {
              phone: phone || "unknown",
              client_id: clientId || "unknown",
            },
            //conversation_config_override: {
              //agent: {
                //prompt: {
                  //prompt: "You're Gary from the phone store. If you see phone and client ID, confirm them."
                //},
                //first_message: `Hi! Let's test. Phone: ${phone}, Client ID: ${clientId}`,
              //}
            //}
          };

          console.log("[InitialConfig Payload]", JSON.stringify(initialConfig, null, 2));

          try {
            elevenLabsWs.send(JSON.stringify(initialConfig));
            console.log("[ElevenLabs] Sent initialConfig");
          } catch (err) {
            console.error("[ERROR] Failed to send initialConfig:", err);
          }
        });

        elevenLabsWs.on("message", data => {
          try {
            const message = JSON.parse(data);
            switch (message.type) {
              case "conversation_initiation_metadata":
                console.log("[ElevenLabs] Received initiation metadata");
                break;
              case "audio":
                const payload = message.audio?.chunk || message.audio_event?.audio_base_64;
                if (payload && streamSid) {
                  const audioData = {
                    event: "media",
                    streamSid,
                    media: { payload },
                  };
                  ws.send(JSON.stringify(audioData));
                }
                break;
              case "interruption":
                if (streamSid) {
                  ws.send(JSON.stringify({ event: "clear", streamSid }));
                }
                break;
              case "ping":
                if (message.ping_event?.event_id) {
                  elevenLabsWs.send(JSON.stringify({
                    type: "pong",
                    event_id: message.ping_event.event_id
                  }));
                }
                break;
              case "agent_response":
                console.log(`[Twilio] Agent response: ${message.agent_response_event?.agent_response}`);
                break;
              case "user_transcript":
                console.log(`[Twilio] User transcript: ${message.user_transcription_event?.user_transcript}`);
                break;
              default:
                console.log(`[ElevenLabs] Unhandled message type: ${message.type}`);
            }
          } catch (error) {
            console.error("[ElevenLabs] Error processing message:", error);
          }
        });

        elevenLabsWs.on("error", error => {
          console.error("[ElevenLabs] WebSocket error:", error);
        });

        elevenLabsWs.on("close", () => {
          console.log("[ElevenLabs] Disconnected");
        });
      } catch (error) {
        console.error("[ElevenLabs] Setup error:", error);
      }
    };

    setupElevenLabs();

    ws.on("message", message => {
      try {
        const msg = JSON.parse(message);
        if (msg.event !== "media") {
          console.log(`[Twilio] Received event: ${msg.event}`);
        }

        switch (msg.event) {
          case "start":
            streamSid = msg.start.streamSid;
            callSid = msg.start.callSid;
            console.log(`[Twilio] Stream started - StreamSid: ${streamSid}, CallSid: ${callSid}`);
            break;
          case "media":
            if (elevenLabsWs?.readyState === WebSocket.OPEN) {
              const audioMessage = {
                user_audio_chunk: Buffer.from(msg.media.payload, "base64").toString("base64"),
              };
              elevenLabsWs.send(JSON.stringify(audioMessage));
            }
            break;
          case "stop":
            console.log(`[Twilio] Stream ${streamSid} ended`);
            if (elevenLabsWs?.readyState === WebSocket.OPEN) {
              elevenLabsWs.close();
            }
            break;
          default:
            console.log(`[Twilio] Unhandled event: ${msg.event}`);
        }
      } catch (error) {
        console.error("[Twilio] Error processing message:", error);
      }
    });

    ws.on("close", () => {
      console.log("[Twilio] Client disconnected");
      if (elevenLabsWs?.readyState === WebSocket.OPEN) {
        elevenLabsWs.close();
      }
    });

    ws.on("error", console.error);
  });
});

fastify.listen({ port: PORT, host: "0.0.0.0" }, err => {
  if (err) {
    console.error("Error starting server:", err);
    process.exit(1);
  }
  console.log(`[Server] Listening on port ${PORT}`);
});



