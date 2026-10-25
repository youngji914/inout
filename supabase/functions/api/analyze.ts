// Claude 비전 모델로 식사 사진의 음식과 칼로리를 추정한다.

import Anthropic from "@anthropic-ai/sdk";
import { encodeBase64 } from "@std/encoding/base64";
import { HttpError } from "./http.ts";

export interface FoodItem {
  name: string;
  calories_kcal: number;
}

export interface Analysis {
  is_food: boolean;
  food_name: string;
  calories_kcal: number;
  items: FoodItem[];
  description: string;
}

export type Analyzer = (image: Uint8Array, mediaType: string) => Promise<Analysis>;

const MODEL = Deno.env.get("CLAUDE_MODEL") ?? "claude-opus-5-5";

const SYSTEM_PROMPT = `당신은 다이어트 앱에서 식사 사진의 칼로리를 추정하는 영양 전문가입니다.
사진에 보이는 음식을 모두 식별하고, 보이는 양을 기준으로 각각의 칼로리를 추정하세요.
- food_name: 한국에서 통용되는 이름. 여러 음식이면 쉼표로 이어 적습니다 (예: "김치찌개, 공기밥").
- items: 음식별 이름과 추정 칼로리(kcal, 정수).
- calories_kcal: items 칼로리의 합계.
- 양이 애매하면 한국 식당의 일반적인 1인분을 기준으로 합니다.
- description: 양을 어떻게 판단했는지 한 문장으로 한국어로 적습니다.
- 사진에 음식이 없으면 is_food를 false로 하고 food_name은 빈 문자열, items는 빈 배열, calories_kcal은 0으로 둡니다.`;

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    is_food: { type: "boolean" },
    food_name: { type: "string" },
    calories_kcal: { type: "integer" },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, calories_kcal: { type: "integer" } },
        required: ["name", "calories_kcal"],
        additionalProperties: false,
      },
    },
    description: { type: "string" },
  },
  required: ["is_food", "food_name", "calories_kcal", "items", "description"],
  additionalProperties: false,
};

type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

export function claudeAnalyzer(): Analyzer {
  const client = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });

  return async (image, mediaType) => {
    let response;
    try {
      response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 4096,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        thinking: { type: "adaptive" },
        output_config: { effort: "low", format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
        system: SYSTEM_PROMPT,
        messages: [{
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mediaType as ImageMediaType, data: encodeBase64(image) },
            },
            { type: "text", text: "이 식사의 음식과 칼로리를 추정해 주세요." },
          ],
        }],
      });
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) {
        console.error("Claude authentication failed", e.message);
        throw new HttpError(500, "서버의 Claude API 키 설정을 확인해 주세요.");
      }
      if (e instanceof Anthropic.BadRequestError) {
        console.error("Claude bad request", e.message);
        throw new HttpError(400, "이 사진은 분석할 수 없습니다. 직접 입력해 주세요.");
      }
      if (e instanceof Anthropic.RateLimitError) {
        throw new HttpError(429, "요청이 많습니다. 잠시 후 다시 시도해 주세요.");
      }
      if (e instanceof Anthropic.APIConnectionError) {
        console.error("Claude connection error", e.message);
        throw new HttpError(503, "분석 서버에 연결할 수 없습니다.");
      }
      if (e instanceof Anthropic.APIError) {
        console.error("Claude API error", e.status, e.message);
        throw new HttpError(502, "분석 서버에 문제가 발생했습니다.");
      }
      throw e;
    }

    if (response.stop_reason === "refusal") {
      throw new HttpError(422, "이 사진은 분석할 수 없습니다. 직접 입력해 주세요.");
    }
    if (response.stop_reason === "max_tokens") throw new HttpError(502, "분석 결과가 중간에 끊겼습니다.");

    const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    if (!text) throw new HttpError(502, "분석 결과가 비어 있습니다.");
    return JSON.parse(text) as Analysis;
  };
}
