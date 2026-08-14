import type { Command } from "../types";
import { fetchJson } from "../http-utils";

interface Meal {
  strMeal: string;
  strCategory?: string;
  strArea?: string;
  strInstructions?: string;
  strMealThumb?: string;
  strYoutube?: string;
  [key: string]: string | undefined;
}

interface PokeData {
  id: number;
  name: string;
  height: number;
  weight: number;
  types: { type: { name: string } }[];
  stats: { base_stat: number; stat: { name: string } }[];
  sprites: { front_default: string | null };
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export const infoCommands: Command[] = [
  {
    name: "recipe",
    aliases: ["meal", "food"],
    category: "TOOLS",
    desc: "Find a cooking recipe (key-free)",
    handler: async (ctx) => {
      const q = ctx.text.trim();
      if (!q) return ctx.reply(`🍳 Usage: *${ctx.prefix}recipe <dish>*\nExample: *${ctx.prefix}recipe pasta*`);
      await ctx.react("⏳");
      let data: { meals: Meal[] | null };
      try {
        data = await fetchJson<{ meals: Meal[] | null }>(
          `https://www.themealdb.com/api/json/v1/1/search.php?s=${encodeURIComponent(q)}`,
        );
      } catch {
        return ctx.reply("❌ Couldn't reach the recipe service. Try again later.");
      }
      const meal = data.meals?.[0];
      if (!meal) return ctx.reply(`❌ No recipe found for "${q}".`);

      const ingredients: string[] = [];
      for (let i = 1; i <= 20; i++) {
        const ing = meal[`strIngredient${i}`]?.trim();
        const mea = meal[`strMeasure${i}`]?.trim();
        if (ing) ingredients.push(`• ${mea ? `${mea} ` : ""}${ing}`);
      }
      const instr = (meal.strInstructions ?? "").trim();
      const caption =
        `🍽️ *${meal.strMeal}*\n` +
        `${meal.strCategory ? `📂 ${meal.strCategory}` : ""}${meal.strArea ? ` · 🌍 ${meal.strArea}` : ""}\n\n` +
        `*Ingredients:*\n${ingredients.join("\n") || "—"}\n\n` +
        `*Instructions:*\n${instr.length > 1200 ? `${instr.slice(0, 1200)}…` : instr}` +
        `${meal.strYoutube ? `\n\n▶️ ${meal.strYoutube}` : ""}`;

      if (meal.strMealThumb) {
        await ctx.sock.sendMessage(ctx.from, { image: { url: meal.strMealThumb }, caption }, { quoted: ctx.msg });
      } else {
        await ctx.reply(caption);
      }
    },
  },
  {
    name: "pokemon",
    aliases: ["pokedex", "dex"],
    category: "TOOLS",
    desc: "Look up a Pokémon (key-free)",
    handler: async (ctx) => {
      const raw = ctx.text.trim();
      const q = raw.toLowerCase().replace(/\s+/g, "-");
      if (!q) return ctx.reply(`🔴 Usage: *${ctx.prefix}pokemon <name>*\nExample: *${ctx.prefix}pokemon pikachu*`);
      await ctx.react("⏳");
      let p: PokeData;
      try {
        p = await fetchJson<PokeData>(`https://pokeapi.co/api/v2/pokemon/${encodeURIComponent(q)}`);
      } catch {
        return ctx.reply(`❌ No Pokémon found called "${raw}".`);
      }
      const types = p.types.map((t) => cap(t.type.name)).join(", ");
      const stats = p.stats.map((s) => `• ${s.stat.name}: ${s.base_stat}`).join("\n");
      const caption =
        `🔴 *${cap(p.name)}* (#${p.id})\n\n` +
        `📏 Height: ${p.height / 10} m\n` +
        `⚖️ Weight: ${p.weight / 10} kg\n` +
        `✨ Type: ${types}\n\n` +
        `*Base stats:*\n${stats}`;
      const sprite = p.sprites?.front_default;
      if (sprite) {
        await ctx.sock.sendMessage(ctx.from, { image: { url: sprite }, caption }, { quoted: ctx.msg });
      } else {
        await ctx.reply(caption);
      }
    },
  },
];
