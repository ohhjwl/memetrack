import { createFileRoute } from "@tanstack/react-router";
import { Discover } from "@/components/discover";

export const Route = createFileRoute("/")({
  component: Discover,
});
