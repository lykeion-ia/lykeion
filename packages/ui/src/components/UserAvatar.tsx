import type { User } from "@lykeion/api";
import { userFace } from "../lib/assignee";
import { cn } from "../lib/utils";

/**
 * A member's face: their uploaded picture, or their initials on the gradient
 * `userFace` gives them.
 *
 * One component for both states rather than a picture with a fallback beside
 * it, so every surface that draws a person gets the same circle whether or not
 * that person has got round to uploading anything.
 */
export function UserAvatar({
  user,
  size = 40,
  className,
}: {
  user: User;
  /** Diameter in CSS pixels. The initials scale with it. */
  size?: number;
  className?: string;
}) {
  const face = userFace(user);
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center overflow-hidden rounded-full font-semibold text-white",
        className,
      )}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.36),
        // Painted even when a picture covers it, so a picture that fails to
        // decode leaves a circle rather than a hole.
        backgroundImage: `linear-gradient(135deg, ${face.gradient[0]}, ${face.gradient[1]})`,
      }}
    >
      {face.pictureUrl ? (
        <img
          src={face.pictureUrl}
          // Empty alt with the name on the wrapper's title would announce
          // twice; the picture IS the person, so it carries the name itself.
          alt={face.label}
          className="h-full w-full object-cover"
        />
      ) : (
        face.initials
      )}
    </span>
  );
}

export default UserAvatar;
