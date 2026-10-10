import { useId } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Defs, Path, Pattern, Rect } from 'react-native-svg';

export function LinePatternBackground() {
  const patternId = `edumatchLines${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  return <View
    pointerEvents="none"
    accessible={false}
    accessibilityElementsHidden
    importantForAccessibility="no-hide-descendants"
    style={[StyleSheet.absoluteFill, styles.background]}
  >
    <Svg width="100%" height="100%">
      <Defs>
        <Pattern id={patternId} width={88} height={88} patternUnits="userSpaceOnUse">
          <Path d="M0 44.5 H88" fill="none" stroke="#3F7F2A" strokeWidth={1} strokeOpacity={0.08} />
          <Path d="M44.5 0 V88" fill="none" stroke="#3F7F2A" strokeWidth={1} strokeOpacity={0.06} />
        </Pattern>
      </Defs>
      <Rect width="100%" height="100%" fill={`url(#${patternId})`} />
    </Svg>
  </View>;
}

const styles = StyleSheet.create({
  background: { overflow: 'hidden', backgroundColor: '#F8FAFC' },
});
