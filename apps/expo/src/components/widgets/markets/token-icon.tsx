import { useState } from "react";
import { View, type ImageSourcePropType } from "react-native";
import Svg, { Path } from "react-native-svg";
import { Image } from "expo-image";
import { Activity } from "lucide-react-native";

import { useUi } from "~/components/ui/tokens";
import { getTokenLogo } from "~/lib/venues/token-logos";

type MarketVenue = "hyperliquid" | "perpl" | "polymarket";

const POLYMARKET_LOGO =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../../../../assets/venues/POLYMARKET_logo.png") as ImageSourcePropType;

const VENUE_LOGOS = {
  hyperliquid: {
    uri: "https://hyperliquid.xyz/favicon-32x32.png",
  },
  polymarket: POLYMARKET_LOGO,
} as const;

export function MarketTokenIcon({ symbol }: { symbol: string }) {
  const ui = useUi();
  const [imageFailed, setImageFailed] = useState(false);
  const imageSource = getTokenLogo(symbol);

  return (
    <MarketIconFrame>
      {imageSource && !imageFailed ? (
        <Image
          accessibilityLabel={`${symbol} token logo`}
          source={imageSource}
          contentFit="contain"
          onError={() => setImageFailed(true)}
          style={{ width: 32, height: 32 }}
        />
      ) : (
        <Activity size={16} color={ui.primary} />
      )}
    </MarketIconFrame>
  );
}

export function MarketImageIcon({
  imageUrl,
  fallbackVenue,
}: {
  imageUrl?: string;
  fallbackVenue: MarketVenue;
}) {
  const [imageFailed, setImageFailed] = useState(false);

  if (!imageUrl || imageFailed) {
    return <MarketVenueIcon venue={fallbackVenue} />;
  }

  return (
    <MarketIconFrame>
      <Image
        accessibilityLabel="Prediction market logo"
        source={{ uri: imageUrl }}
        contentFit="cover"
        onError={() => setImageFailed(true)}
        style={{ width: 32, height: 32 }}
      />
    </MarketIconFrame>
  );
}

export function MarketVenueIcon({ venue }: { venue: MarketVenue }) {
  const ui = useUi();
  const [imageFailed, setImageFailed] = useState(false);
  const imageSource = venue === "perpl" ? undefined : VENUE_LOGOS[venue];

  return (
    <MarketIconFrame>
      {venue === "perpl" ? (
        <Svg width={20} height={20} viewBox="0 0 32 32">
          <Path
            d="M9.71373 0H4V31H9.71373V0Z M21.5062 15.4392H15.7925V31H21.5062V15.4392Z M27.2196 0H21.5059V15.4392H27.2196V0Z"
            fill={ui.text}
          />
        </Svg>
      ) : imageSource && !imageFailed ? (
        <Image
          accessibilityLabel={`${venue} logo`}
          source={imageSource}
          contentFit="contain"
          onError={() => setImageFailed(true)}
          style={{ width: 32, height: 32 }}
        />
      ) : (
        <Activity size={16} color={ui.primary} />
      )}
    </MarketIconFrame>
  );
}

function MarketIconFrame({ children }: React.PropsWithChildren) {
  const ui = useUi();

  return (
    <View
      className="mr-2.5 h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full"
      style={{
        backgroundColor: ui.primarySoft,
      }}
    >
      {children}
    </View>
  );
}
