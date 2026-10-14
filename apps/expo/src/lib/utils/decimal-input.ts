export const sanitizeDecimalInput = (
  value: string,
  maxFractionDigits?: number,
) => {
  let sanitized = "";
  let decimalSeparatorSeen = false;
  let fractionDigits = 0;

  for (const character of value.replace(/,/g, ".")) {
    if (character >= "0" && character <= "9") {
      if (
        decimalSeparatorSeen &&
        maxFractionDigits !== undefined &&
        fractionDigits >= maxFractionDigits
      ) {
        continue;
      }

      sanitized += character;
      if (decimalSeparatorSeen) fractionDigits += 1;
    } else if (character === "." && !decimalSeparatorSeen) {
      sanitized += character;
      decimalSeparatorSeen = true;
    }
  }

  return sanitized;
};
