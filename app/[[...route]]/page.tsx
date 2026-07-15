import MorseApp from "../_components/morse-app";

type PageProps = { params: Promise<{ route?: string[] }> };

export default async function AppPage({ params }: PageProps) {
  const { route = [] } = await params;
  const initialPath = route.length === 0 ? "/" : `/${route.map(encodeURIComponent).join("/")}`;
  return <MorseApp initialPath={initialPath} />;
}
