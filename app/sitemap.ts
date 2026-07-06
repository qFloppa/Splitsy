import type { MetadataRoute } from "next";

const BASE_URL = "https://splitsy.xyz";
const lastModified = "2026-06-25T00:00:00.000Z";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: `${BASE_URL}/`,
      lastModified,
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${BASE_URL}/docs`,
      lastModified,
      changeFrequency: "monthly",
      priority: 0.8,
    },
    {
      url: `${BASE_URL}/disclaimer`,
      lastModified,
      changeFrequency: "yearly",
      priority: 0.5,
    },
    {
      url: `${BASE_URL}/legal`,
      lastModified,
      changeFrequency: "yearly",
      priority: 0.5,
    },
  ];
}
