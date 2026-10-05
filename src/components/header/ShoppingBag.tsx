import { createPortal } from "react-dom";
import { X, Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/LocaleLink";
import { useCart } from "@/context/CartContext";
import { formatPrice } from "@/data/products";
import { useTranslation } from "react-i18next";
import { useProductText } from "@/i18n/useProductText";

interface ShoppingBagProps {
  isOpen: boolean;
  onClose: () => void;
  onViewFavorites?: () => void;
}

const ShoppingBag = ({ isOpen, onClose, onViewFavorites }: ShoppingBagProps) => {
  const { t } = useTranslation("shop");
  const { localize } = useProductText();
  const { items, updateQuantity, subtotal, dueNow, dueLater, hasPreorders } = useCart();

  if (!isOpen) return null;

  // Portal to <body>: the header <nav> uses backdrop-blur, which would otherwise
  // become the containing block for this fixed overlay.
  return createPortal(
    <div className="fixed inset-0 z-50 h-dvh">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
      />

      {/* Off-canvas panel */}
      <div className="absolute right-3 top-3 bottom-3 sm:right-5 sm:top-5 sm:bottom-5 w-[calc(100%-1.5rem)] sm:w-96 overflow-hidden rounded-xl bg-background border border-border shadow-2xl animate-slide-in-right flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-border">
          <h2 className="text-lg font-light text-foreground">{t("shoppingBag.title")}</h2>
          <button
            onClick={onClose}
            className="p-2 text-foreground hover:text-muted-foreground transition-colors"
            aria-label={t("shoppingBag.close")}
          >
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 min-h-0 flex flex-col p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
          {/* Mobile favorites toggle - only show on mobile */}
          {onViewFavorites && (
            <div className="md:hidden mb-6 pb-6 border-b border-border">
              <button
                onClick={onViewFavorites}
                className="w-full flex items-center justify-center gap-2 py-3 px-4 border border-border rounded-lg text-nav-foreground hover:text-nav-hover hover:border-nav-hover transition-colors duration-200"
              >
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor" className="w-5 h-5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12Z" />
                </svg>
                <span className="text-sm font-light">{t("shoppingBag.viewFavorites")}</span>
              </button>
            </div>
          )}

          {items.length === 0 ? (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-muted-foreground text-sm text-center">
                {t("shoppingBag.emptyLine1")}<br />
                {t("shoppingBag.emptyLine2")}
              </p>
            </div>
          ) : (
            <>
              {/* Cart items */}
              <div className="flex-1 overflow-y-auto space-y-6 mb-6">
                {items.map(localize).map((item) => (
                  <div key={item.id} className="flex gap-4">
                    <div className="w-20 h-20 bg-muted/10 rounded-lg overflow-hidden">
                      <img
                        src={item.image}
                        alt={item.name}
                        className="w-full h-full object-cover"
                      />
                    </div>
                    <div className="flex-1">
                      <div className="flex justify-between items-start mb-2">
                        <div>
                          <p className="text-sm font-light text-muted-foreground">{item.categoryLabel}</p>
                          <h3 className="text-sm font-medium text-foreground">{item.name}</h3>
                          {item.preorder && (
                            <p className="mt-1 text-xs font-medium text-accent">
                              {t("preorder.cartLine", { deposit: formatPrice(item.preorder.deposit) })}
                            </p>
                          )}
                        </div>
                        <p className="text-sm font-light text-foreground text-right">
                          {item.regularPrice && item.regularPrice > item.price && (
                            <span className="block text-xs text-muted-foreground line-through">
                              {formatPrice(item.regularPrice)}
                            </span>
                          )}
                          {formatPrice(item.price)}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 mt-3">
                        <div className="flex items-center border border-border">
                          <button
                            onClick={() => updateQuantity(item.id, item.quantity - 1)}
                            className="p-2 hover:bg-muted/50 transition-colors"
                            aria-label={t("shoppingBag.decreaseQuantity")}
                          >
                            <Minus size={14} />
                          </button>
                          <span className="px-3 py-2 text-sm font-light min-w-[40px] text-center">
                            {item.quantity}
                          </span>
                          <button
                            onClick={() => updateQuantity(item.id, item.quantity + 1)}
                            className="p-2 hover:bg-muted/50 transition-colors"
                            aria-label={t("shoppingBag.increaseQuantity")}
                          >
                            <Plus size={14} />
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Subtotal and checkout */}
              <div className="border-t border-border pt-6 space-y-4">
                <div className="flex justify-between items-center">
                  <span className="text-sm font-light text-foreground">{t("shoppingBag.subtotal")}</span>
                  <span className="text-sm font-medium text-foreground">
                    {formatPrice(subtotal)}
                  </span>
                </div>

                {hasPreorders && (
                  <div className="space-y-1 rounded-xl bg-secondary/60 p-3 text-sm">
                    <div className="flex justify-between">
                      <span className="font-medium text-foreground">{t("preorder.dueNow")}</span>
                      <span className="font-semibold text-foreground">{formatPrice(dueNow)}</span>
                    </div>
                    <div className="flex justify-between text-muted-foreground">
                      <span>{t("preorder.dueLater")}</span>
                      <span>{formatPrice(dueLater)}</span>
                    </div>
                  </div>
                )}

                {(() => {
                  const savings = items.reduce(
                    (sum, item) =>
                      sum +
                      (item.regularPrice && item.regularPrice > item.price
                        ? (item.regularPrice - item.price) * item.quantity
                        : 0),
                    0,
                  );
                  return savings > 0 ? (
                    <div className="flex justify-between items-center">
                      <span className="text-sm font-light text-foreground">{t("shoppingBag.youSave")}</span>
                      <span className="text-sm font-medium text-foreground">−{formatPrice(savings)}</span>
                    </div>
                  ) : null;
                })()}

                <p className="text-xs text-muted-foreground">
                  {t("shoppingBag.shippingNote")}
                </p>

                <Button
                  asChild
                  className="w-full rounded-full bg-brand-gradient text-white shadow-glow hover:brightness-110 transition-[filter]"
                  size="lg"
                  onClick={onClose}
                >
                  <Link to="/checkout">
                    {t("shoppingBag.proceedToCheckout")}
                  </Link>
                </Button>

                <Button
                  variant="outline"
                  className="w-full rounded-full border-accent/40 hover:bg-secondary"
                  size="lg"
                  onClick={onClose}
                  asChild
                >
                  <Link to="/category/shop">
                    {t("shoppingBag.continueShopping")}
                  </Link>
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default ShoppingBag;
