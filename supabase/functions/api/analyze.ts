// Claude로 식사 사진이나 음식 이름에서 칼로리·탄단지를 추정한다.

import Anthropic from "@anthropic-ai/sdk";
import { encodeBase64 } from "@std/encoding/base64";
import { HttpError } from "./http.ts";

export interface FoodItem {
  name: string;
  calories_kcal: number;
  carbs_g: number;
  protein_g: number;
  fat_g: number;
}

export interface Analysis {
  is_food: boolean;
  food_name: string;
  calories_kcal: number;
  items: FoodItem[];
  description: string;
}

export interface FoodAi {
  /** 식사 사진 속 음식을 항목별로 식별하고 칼로리·탄단지를 추정한다. */
  analyzePhoto(image: Uint8Array, mediaType: string): Promise<Analysis>;
  /** 음식 이름(양이 적혀 있으면 그 양)으로 일반적인 칼로리·탄단지를 추정한다. 입력 순서대로 돌려준다. */
  estimate(names: string[]): Promise<FoodItem[]>;
}

const MODEL = Deno.env.get("CLAUDE_MODEL") ?? "claude-opus-5-5";

const ITEM_RULES = `- calories_kcal: 칼로리(kcal, 정수).
- carbs_g, protein_g, fat_g: 탄수화물·단백질·지방(g, 소수 첫째 자리까지).
- 양이 애매하면 한국 식당의 일반적인 1인분을 기준으로 합니다.`;

const PHOTO_PROMPT = `당신은 다이어트 앱에서 식사 사진의 칼로리를 추정하는 영양 전문가입니다.
사진에 보이는 음식을 모두 식별하고, 보이는 양을 기준으로 각각을 추정하세요.
- food_name: 한국에서 통용되는 이름. 여러 음식이면 쉼표로 이어 적습니다 (예: "김치찌개, 공기밥").
- items: 음식별 이름과 추정값.
${ITEM_RULES}
- calories_kcal(전체): items 칼로리의 합계.
- description: 양을 어떻게 판단했는지 한 문장으로 한국어로 적습니다.
- 사진에 음식이 없으면 is_food를 false로 하고 food_name은 빈 문자열, items는 빈 배열, calories_kcal은 0으로 둡니다.`;

const ESTIMATE_PROMPT = `당신은 다이어트 앱에서 사용자가 입력한 음식의 칼로리를 추정하는 영양 전문가입니다.
입력된 음식마다 한 항목씩, 입력 순서 그대로 추정값을 돌려주세요.
- name: 입력한 이름을 그대로 적습니다.
- 이름에 양이 적혀 있으면(예: "라면 반 개", "삼겹살 200g", "밥 두 공기") 그 양을 기준으로 합니다.
${ITEM_RULES}`;

const ITEM_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    calories_kcal: { type: "integer" },
    carbs_g: { type: "number" },
    protein_g: { type: "number" },
    fat_g: { type: "number" },
  },
  required: ["name", "calories_kcal", "carbs_g", "protein_g", "fat_g"],
  additionalProperties: false,
};

const PHOTO_SCHEMA = {
  type: "object",
  properties: {
    is_food: { type: "boolean" },
    food_name: { type: "string" },
    calories_kcal: { type: "integer" },
    items: { type: "array", items: ITEM_SCHEMA },
    description: { type: "string" },
  },
  required: ["is_food", "food_name", "calories_kcal", "items", "description"],
  additionalProperties: false,
};

const ESTIMATE_SCHEMA = {
  type: "object",
  properties: { items: { type: "array", items: ITEM_SCHEMA } },
  required: ["items"],
  additionalProperties: false,
};

type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
type UserContent = Anthropic.Beta.Messages.BetaContentBlockParam[];

export function claudeFoodAi(): FoodAi {
  const client = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });

  async function ask<T>(system: string, schema: Record<string, unknown>, content: UserContent): Promise<T> {
    let response;
    try {
      response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 4096,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        thinking: { type: "adaptive" },
        output_config: { effort: "low", format: { type: "json_schema", schema } },
        system,
        messages: [{ role: "user", content }],
      });
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) {
        console.error("Claude authentication failed", e.message);
        throw new HttpError(500, "서버의 Claude API 키 설정을 확인해 주세요.");
      }
      if (e instanceof Anthropic.BadRequestError) {
        console.error("Claude bad request", e.message);
        throw new HttpError(400, "분석할 수 없습니다. 직접 입력해 주세요.");
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

    if (response.stop_reason === "refusal") throw new HttpError(422, "분석할 수 없습니다. 직접 입력해 주세요.");
    if (response.stop_reason === "max_tokens") throw new HttpError(502, "분석 결과가 중간에 끊겼습니다.");

    const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    if (!text) throw new HttpError(502, "분석 결과가 비어 있습니다.");
    return JSON.parse(text) as T;
  }

  return {
    analyzePhoto(image, mediaType) {
      return ask<Analysis>(PHOTO_PROMPT, PHOTO_SCHEMA, [
        {
          type: "image",
          source: { type: "base64", media_type: mediaType as ImageMediaType, data: encodeBase64(image) },
        },
        { type: "text", text: "이 식사의 음식과 칼로리를 추정해 주세요." },
      ]);
    },
    async estimate(names) {
      const { items } = await ask<{ items: FoodItem[] }>(ESTIMATE_PROMPT, ESTIMATE_SCHEMA, [
        { type: "text", text: names.map((n, i) => `${i + 1}. ${n}`).join("\n") },
      ]);
      if (items.length !== names.length) throw new HttpError(502, "추정 결과가 입력과 맞지 않습니다.");
      return items.map((it, i) => ({ ...it, name: names[i] }));
    },
  };
}
