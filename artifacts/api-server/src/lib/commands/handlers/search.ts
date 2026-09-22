import type { Command } from "../types";
import { fetchJson, fetchText } from "../http-utils";

interface WttrResponse {
  current_condition?: Array<{
    temp_C: string;
    FeelsLikeC: string;
    humidity: string;
    windspeedKmph: string;
    weatherDesc?: Array<{ value: string }>;
  }>;
  nearest_area?: Array<{
    areaName?: Array<{ value: string }>;
    country?: Array<{ value: string }>;
  }>;
}

interface WikiSummary {
  type?: string;
  title?: string;
  extract?: string;
  content_urls?: { desktop?: { page?: string } };
}

type DictionaryResponse = Array<{
  word: string;
  phonetic?: string;
  meanings: Array<{
    partOfSpeech: string;
    definitions: Array<{ definition: string; example?: string }>;
  }>;
}>;

interface NpmResponse {
  "dist-tags"?: { latest?: string };
  description?: string;
  homepage?: string;
  license?: string;
  versions?: Record<string, { description?: string }>;
}

interface GithubRepo {
  full_name?: string;
  description?: string;
  stargazers_count?: number;
  forks_count?: number;
  open_issues_count?: number;
  language?: string;
  html_url?: string;
}

interface DdgRelatedTopic {
  Text?: string;
  FirstURL?: string;
}

interface DdgResponse {
  Heading?: string;
  AbstractText?: string;
  AbstractURL?: string;
  Image?: string;
  RelatedTopics?: DdgRelatedTopic[];
}

interface LrclibTrack {
  trackName?: string;
  artistName?: string;
  plainLyrics?: string | null;
}

interface WallhavenSearch {
  data?: Array<{ path?: string }>;
}

interface UrbanResponse {
  list?: Array<{
    word?: string;
    definition?: string;
    example?: string;
    thumbs_up?: number;
    thumbs_down?: number;
  }>;
}

type CountryResponse = Array<{
  name?: { common?: string; official?: string };
  capital?: string[];
  region?: string;
  subregion?: string;
  population?: number;
  flag?: string;
  currencies?: Record<string, { name?: string; symbol?: string }>;
  languages?: Record<string, string>;
}>;

function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

export const searchCommands: Command[] = [];
